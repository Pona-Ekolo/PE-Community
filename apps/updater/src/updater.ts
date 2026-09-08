import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { UpdaterConfig } from './config.js';
import {
  ALLOWED_IMAGE_REPOSITORIES,
  UPDATER_VERSION,
  UPDATER_PROTOCOL_VERSION,
  canCancel,
  compareVersions,
  parseVersion,
  sanitizeLog,
  transitionRun,
  type ReleaseManifest,
  type UpdateLogEvent,
  type UpdateLogLevel,
  type UpdatePhase,
  type UpdateRun,
} from './domain.js';
import type { CommandExecutor } from './executor.js';
import {
  GitHubCliProvenanceVerifier,
  ProvenanceError,
  type ProvenanceVerifier,
} from './provenance.js';
import { verifyManifestImage } from './release-verifier.js';
import type { ReleaseProvider } from './release.js';
import { AgentStore } from './store.js';

const REQUIRED_ENV_KEYS = ['PE_COMMUNITY_VERSION', 'POSTGRES_PASSWORD', 'JWT_SECRET', 'PASSWORD_PEPPER', 'EMAIL_ENCRYPTION_KEY', 'WEB_ORIGIN'];
const MAX_STREAM_EVENTS_PER_COMMAND = 1_000;

export class UpdaterAgent {
  constructor(
    private readonly config: UpdaterConfig,
    private readonly store: AgentStore,
    private readonly executor: CommandExecutor,
    private readonly releases: ReleaseProvider,
    private readonly imageRepositories: Record<'api' | 'web' | 'worker', string> = ALLOWED_IMAGE_REPOSITORIES,
    private readonly provenance: ProvenanceVerifier = new GitHubCliProvenanceVerifier(executor),
  ) {}

  async initialize() {
    await this.store.initialize();
    const interrupted = await this.store.takeInterruptedRun();
    if (interrupted) await this.recoverInterruptedRun(interrupted);
  }

  async status() {
    return {
      agentVersion: UPDATER_VERSION,
      protocolVersion: UPDATER_PROTOCOL_VERSION,
      topology: this.config.topology,
    };
  }

  async check() {
    const release = await this.releases.latest();
    return { ...release, manifest: release.manifest };
  }

  async install(input: { version: unknown; idempotencyKey: unknown }) {
    const targetVersion = validInstallVersion(input.version);
    const idempotencyKey = validIdempotencyKey(input.idempotencyKey);
    const duplicate = await this.store.findByIdempotencyKey(idempotencyKey);
    if (duplicate) return duplicate;
    const installedVersion = await this.installedVersion();
    if (compareVersions(targetVersion, installedVersion) <= 0) throw new AgentError('TARGET_NOT_NEWER', 400);
    const run: UpdateRun = {
      id: randomUUID(), idempotencyKey, installedVersion, targetVersion, status: 'PENDING', phase: 'PENDING',
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null, failureCode: null, failureSummary: null,
      rollbackStatus: 'NOT_REQUIRED', releaseMetadataSnapshot: null, lastSequence: 0, cancellationRequested: false,
      provenanceResults: [],
    };
    try {
      await this.store.acquireLock(run.id);
    } catch (error) {
      if (error instanceof Error && error.message === 'UPDATE_IN_PROGRESS') {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const concurrentDuplicate = await this.store.findByIdempotencyKey(idempotencyKey);
          if (concurrentDuplicate) return concurrentDuplicate;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new AgentError('UPDATE_IN_PROGRESS', 409);
      }
      throw error;
    }
    await this.store.saveRun(run);
    void this.execute(run).finally(async () => {
      await this.store.releaseLock();
      await this.store.pruneRuns();
    });
    return run;
  }

  async run(id: string, afterSequence = 0) {
    const run = await this.store.loadRun(id);
    if (!run) throw new AgentError('RUN_NOT_FOUND', 404);
    return { run, events: await this.store.events(id, afterSequence) };
  }

  async cancel(id: string) {
    const run = await this.store.loadRun(id);
    if (!run) throw new AgentError('RUN_NOT_FOUND', 404);
    if (!canCancel(run.phase)) throw new AgentError('CANCELLATION_UNSAFE', 409);
    const updated = { ...run, cancellationRequested: true };
    await this.store.saveRun(updated);
    return updated;
  }

  private async execute(initial: UpdateRun) {
    let run = initial;
    let originalEnv = '';
    let manifest: ReleaseManifest | null = null;
    try {
      run = await this.phase(run, 'PREFLIGHT', 'PREFLIGHT_STARTED', 'Preflight checks started.');
      const release = await this.releases.target(run.targetVersion);
      manifest = release.manifest;
      run = {
        ...run,
        releaseMetadataSnapshot: manifest,
        provenanceResults: [release.manifestProvenance],
        rollbackStatus: automaticRollbackAllowed(manifest) ? 'AVAILABLE' : 'UNSAFE',
      };
      await this.store.saveRun(run);
      await this.log(run, 'SUCCESS', 'SYSTEM_UPDATE_MANIFEST_PROVENANCE_VERIFIED', 'Release authenticity verified.');
      await this.validateCompatibility(run, manifest);
      await this.preflight(manifest);
      run = await this.cancelIfRequested(run);

      run = await this.phase(run, 'BACKUP', 'BACKUP_STARTED', 'Creating and validating the update backup.');
      await this.backup(run);
      await this.log(run, 'SUCCESS', 'BACKUP_VALIDATED', 'Backup created and validated.');

      originalEnv = await readFile(this.config.envFile, 'utf8');
      await writeVersion(this.config.envFile, originalEnv, run.targetVersion);
      run = await this.phase(run, 'PULLING', 'IMAGE_PULL_STARTED', 'Pulling exact release images while current services remain online.');
      await this.composeWithLogs(run, ['pull', 'api', 'web', 'worker'], 30 * 60_000, 'IMAGE_PULL_OUTPUT');
      run = await this.cancelIfRequested(run, async () => writeFile(this.config.envFile, originalEnv, { mode: 0o600 }));

      run = await this.phase(run, 'VERIFYING', 'IMAGE_VERIFY_STARTED', 'Verifying image repositories and digests.');
      await this.verifyImages(manifest, run.targetVersion, run);
      await this.log(run, 'SUCCESS', 'IMAGES_VERIFIED', 'All release images and provenance attestations match the approved release.');

      run = await this.phase(run, 'MIGRATING', 'MIGRATION_STARTED', 'Applying production database migrations with the target API image.');
      await this.composeWithLogs(run, ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'api', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], 15 * 60_000, 'MIGRATION_OUTPUT');
      await this.composeWithLogs(run, ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'api', 'node_modules/prisma/build/index.js', 'migrate', 'status'], 5 * 60_000, 'MIGRATION_STATUS_OUTPUT');
      await this.log(run, 'SUCCESS', 'MIGRATION_COMPLETED', 'Database migrations completed.');

      run = await this.phase(run, 'DEPLOYING', 'DEPLOYMENT_STARTED', 'Recreating application services with the verified release.');
      await this.composeWithLogs(run, ['up', '-d', '--no-deps', 'api', 'web', 'worker'], 15 * 60_000, 'DEPLOYMENT_OUTPUT');

      run = await this.phase(run, 'HEALTHCHECK', 'HEALTHCHECK_STARTED', 'Waiting for application and dependency health checks.');
      await this.healthChecks(run.targetVersion);
      run = transitionRun(run, 'COMPLETED');
      run = { ...run, rollbackStatus: 'NOT_REQUIRED' };
      await this.store.saveRun(run);
      await this.log(run, 'SUCCESS', 'UPDATE_COMPLETED', `PE Community ${run.targetVersion} is healthy.`);
      await this.pruneBackups();
    } catch (error) {
      if ((error as AgentError).code === 'CANCELLED') return;
      const code = errorCode(error);
      const summary = sanitizeLog(error instanceof Error ? error.message : error);
      if (['MANUAL_ACTION_REQUIRED', 'MINIMUM_VERSION_UNMET', 'UPDATER_MAINTENANCE_REQUIRED', 'LEGACY_RELEASE_MANUAL_REQUIRED'].includes(code)) {
        run = { ...transitionRun(run, 'MANUAL_INTERVENTION_REQUIRED'), failureCode: code, failureSummary: summary, rollbackStatus: 'UNSAFE' };
        await this.store.saveRun(run);
        await this.log(run, 'ERROR', code, 'This release requires operator maintenance before it can be installed.');
        return;
      }
      if (run.phase === 'DEPLOYING' || run.phase === 'HEALTHCHECK') {
        if (manifest && automaticRollbackAllowed(manifest) && originalEnv) {
          try {
            run = await this.phase(run, 'ROLLING_BACK', 'ROLLBACK_STARTED', 'Health checks failed; restoring the previous compatible application release.');
            await writeFile(this.config.envFile, originalEnv, { mode: 0o600 });
            await this.compose(['up', '-d', '--no-deps', 'api', 'web', 'worker'], 15 * 60_000);
            await this.healthChecks(run.installedVersion);
            run = { ...transitionRun(run, 'FAILED'), failureCode: code, failureSummary: summary, rollbackStatus: 'COMPLETED' };
            await this.store.saveRun(run);
            await this.log(run, 'ERROR', 'UPDATE_FAILED_ROLLED_BACK', 'Update failed and the previous application release was restored.');
            return;
          } catch (rollbackError) {
            run = { ...transitionRun(run, 'MANUAL_INTERVENTION_REQUIRED'), failureCode: 'ROLLBACK_FAILED', failureSummary: sanitizeLog(rollbackError), rollbackStatus: 'FAILED' };
            await this.store.saveRun(run);
            await this.log(run, 'ERROR', 'ROLLBACK_FAILED', 'Automatic rollback failed. Manual intervention is required.');
            return;
          }
        }
        run = { ...transitionRun(run, 'MANUAL_INTERVENTION_REQUIRED'), failureCode: code, failureSummary: summary, rollbackStatus: 'UNSAFE' };
      } else {
        if (originalEnv) await writeFile(this.config.envFile, originalEnv, { mode: 0o600 }).catch(() => undefined);
        run = { ...transitionRun(run, 'FAILED'), failureCode: code, failureSummary: summary };
      }
      await this.store.saveRun(run);
      if (code.startsWith('MANIFEST_'))
        await this.log(run, 'ERROR', 'SYSTEM_UPDATE_MANIFEST_PROVENANCE_VERIFICATION_FAILED', 'Release authenticity could not be verified.');
      await this.log(run, 'ERROR', code, summary || 'Update failed.');
    }
  }

  private async validateCompatibility(run: UpdateRun, manifest: ReleaseManifest) {
    if (compareVersions(manifest.version, run.targetVersion) !== 0) throw new Error('MANIFEST_VERSION_MISMATCH');
    if (manifest.requiresManualAction) throw new AgentError('MANUAL_ACTION_REQUIRED');
    if (manifest.supplyChain.attestationPolicy !== 'GITHUB_PROVENANCE_REQUIRED')
      throw new AgentError('LEGACY_RELEASE_MANUAL_REQUIRED');
    if (compareVersions(run.installedVersion, manifest.minimumVersion) < 0) throw new AgentError('MINIMUM_VERSION_UNMET');
    if (compareVersions(`v${UPDATER_VERSION}`, manifest.minimumUpdaterVersion) < 0) throw new AgentError('UPDATER_MAINTENANCE_REQUIRED');
  }

  private async recoverInterruptedRun(run: UpdateRun) {
    const summary = `Updater restart detected during ${run.phase}.`;
    if (['PENDING', 'PREFLIGHT', 'BACKUP', 'PULLING', 'VERIFYING'].includes(run.phase)) {
      const source = await readFile(this.config.envFile, 'utf8');
      await writeVersion(this.config.envFile, source, run.installedVersion);
      const recovered = {
        ...transitionRun(run, 'FAILED'),
        failureCode: 'AGENT_RESTART_SAFE_TO_RETRY',
        failureSummary: `${summary} The installed version was restored and the update may be retried.`,
      };
      await this.store.saveRun(recovered);
      await this.log(recovered, 'ERROR', recovered.failureCode, recovered.failureSummary);
      return;
    }
    if (run.phase === 'MIGRATING') {
      let migrationStatus = 'Migration status could not be determined.';
      try {
        const result = await this.compose(
          ['run', '--rm', '--no-deps', '--entrypoint', 'node', 'api', 'node_modules/prisma/build/index.js', 'migrate', 'status'],
          5 * 60_000,
        );
        migrationStatus = sanitizeLog(result.stdout || result.stderr || 'Migration status completed without output.');
      } catch (error) {
        migrationStatus = sanitizeLog(error);
      }
      await this.manualRecovery(run, 'AGENT_RESTART_DURING_MIGRATION', `${summary} Automatic migration replay is blocked. ${migrationStatus}`);
      return;
    }
    if (run.phase === 'HEALTHCHECK') {
      try {
        await this.healthChecks(run.targetVersion);
        const completed = transitionRun(run, 'COMPLETED');
        await this.store.saveRun(completed);
        await this.log(completed, 'SUCCESS', 'RECOVERED_TARGET_HEALTHY', 'The target release was healthy after updater restart.');
        return;
      } catch (error) {
        await this.manualRecovery(run, 'AGENT_RESTART_HEALTH_UNCONFIRMED', `${summary} Target health could not be confirmed: ${sanitizeLog(error)}`);
        return;
      }
    }
    if (run.phase === 'ROLLING_BACK') {
      try {
        await this.healthChecks(run.installedVersion);
        const failed = {
          ...transitionRun(run, 'FAILED'),
          failureCode: 'UPDATE_FAILED_ROLLBACK_RECOVERED',
          failureSummary: `${summary} The previous release is healthy.`,
          rollbackStatus: 'COMPLETED' as const,
        };
        await this.store.saveRun(failed);
        await this.log(failed, 'ERROR', failed.failureCode, failed.failureSummary);
        return;
      } catch (error) {
        await this.manualRecovery(run, 'AGENT_RESTART_ROLLBACK_UNCONFIRMED', `${summary} Previous-release health could not be confirmed: ${sanitizeLog(error)}`);
        return;
      }
    }
    if (run.phase === 'DEPLOYING') {
      let deploymentState = 'Deployment state could not be inspected.';
      try {
        const [containers, images] = await Promise.all([
          this.compose(['ps', '--format', 'json'], 30_000),
          this.compose(['images', '--format', 'json'], 30_000),
        ]);
        deploymentState = sanitizeLog(`${containers.stdout} ${images.stdout}`);
      } catch (error) {
        deploymentState = sanitizeLog(error);
      }
      await this.manualRecovery(run, 'AGENT_RESTART_DURING_DEPLOYMENT', `${summary} Automatic deployment replay is blocked. ${deploymentState}`);
      return;
    }
    await this.manualRecovery(run, 'AGENT_RESTART_UNSAFE_PHASE', `${summary} Inspect the retained backup and deployment state.`);
  }

  private async manualRecovery(run: UpdateRun, failureCode: string, failureSummary: string) {
    const recovered = {
      ...transitionRun(run, 'MANUAL_INTERVENTION_REQUIRED'),
      failureCode,
      failureSummary: sanitizeLog(failureSummary),
      rollbackStatus: 'UNSAFE' as const,
    };
    await this.store.saveRun(recovered);
    await this.log(recovered, 'ERROR', failureCode, recovered.failureSummary);
  }

  protected async preflight(manifest?: ReleaseManifest) {
    const disk = await statfs(this.config.backupRoot);
    if (disk.bavail * disk.bsize < this.config.minimumFreeBytes) throw new AgentError('INSUFFICIENT_DISK');
    const env = await readFile(this.config.envFile, 'utf8');
    for (const key of REQUIRED_ENV_KEYS) if (!new RegExp(`^${key}=.+$`, 'm').test(env)) throw new AgentError(`REQUIRED_ENV_MISSING_${key}`);
    await this.executor.run('docker', ['info', '--format', '{{json .ServerVersion}}'], { timeoutMs: 30_000 });
    await this.executor.run('docker', ['compose', 'version', '--short'], { timeoutMs: 30_000 });
    if (manifest?.supplyChain.attestationPolicy === 'GITHUB_PROVENANCE_REQUIRED')
      await this.provenance.preflight();
    await this.healthChecks(await this.installedVersion());
  }

  private async backup(run: UpdateRun) {
    const directory = join(this.config.backupRoot, `${run.createdAt.replace(/[:.]/g, '-')}-${run.id}`);
    await mkdir(directory, { mode: 0o700 });
    await copyFile(this.config.envFile, join(directory, '.env'));
    await chmod(join(directory, '.env'), 0o600);
    await copyFile(this.config.composeFile, join(directory, 'docker-compose.prod.yml'));
    await copyFile(this.config.caddyFile, join(directory, 'Caddyfile'));
    await writeFile(join(directory, 'current-version'), `${run.installedVersion}\n`, { mode: 0o600 });
    await writeFile(join(directory, 'target-version'), `${run.targetVersion}\n`, { mode: 0o600 });
    await writeFile(join(directory, 'run-metadata.json'), `${JSON.stringify({ id: run.id, createdAt: run.createdAt, installedVersion: run.installedVersion, targetVersion: run.targetVersion })}\n`, { mode: 0o600 });
    const composePrefix = this.composePrefix();
    const containers = await this.executor.run('docker', [...composePrefix, 'ps', '--format', 'json'], { timeoutMs: 30_000 });
    await writeFile(join(directory, 'containers-before.json'), containers.stdout, { mode: 0o600 });
    const images = await this.executor.run('docker', [...composePrefix, 'images', '--format', 'json'], { timeoutMs: 30_000 });
    await writeFile(join(directory, 'images-before.json'), images.stdout, { mode: 0o600 });
    const dumpPath = join(directory, 'postgres.dump');
    await this.executor.capture('docker', [...composePrefix, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'pe', '-d', 'pe_community', '-Fc'], dumpPath, { timeoutMs: 15 * 60_000 });
    await writeFile(join(directory, 'postgres.dump.sha256'), `${await sha256File(dumpPath)}  postgres.dump\n`, { mode: 0o600 });
    await this.executor.run('docker', [...composePrefix, 'exec', '-T', 'postgres', 'pg_restore', '--list'], { stdinPath: dumpPath, timeoutMs: 5 * 60_000 });
  }

  private async verifyImages(manifest: ReleaseManifest, version: string, run: UpdateRun) {
    for (const service of ['api', 'web', 'worker'] as const) {
      const repository = this.imageRepositories[service];
      if (manifest.images[service].repository !== repository)
        throw new AgentError(`REPOSITORY_MISMATCH_${service.toUpperCase()}`);
      const reference = `${repository}:${version}`;
      const inspected = await this.executor.run('docker', ['image', 'inspect', reference, '--format', '{{json .RepoDigests}}'], { timeoutMs: 30_000 });
      const digests = JSON.parse(inspected.stdout) as string[];
      if (!digests.includes(`${repository}@${manifest.images[service].digest}`)) throw new AgentError(`DIGEST_MISMATCH_${service.toUpperCase()}`);
      try {
        const result = await verifyManifestImage(manifest, service, this.provenance, this.imageRepositories);
        run.provenanceResults = [...run.provenanceResults, result];
        await this.store.saveRun(run);
        await this.log(run, 'SUCCESS', 'SYSTEM_UPDATE_PROVENANCE_VERIFIED', `${service.toUpperCase()} release provenance verified.`);
      } catch (error) {
        const code = error instanceof ProvenanceError ? error.code : errorCode(error);
        await this.log(run, 'ERROR', 'SYSTEM_UPDATE_PROVENANCE_VERIFICATION_FAILED', `${service.toUpperCase()} release authenticity verification failed (${code}).`);
        throw error;
      }
    }
  }

  protected async healthChecks(targetVersion: string) {
    await this.retry(async () => this.compose(['exec', '-T', 'postgres', 'pg_isready', '-U', 'pe', '-d', 'pe_community'], 20_000));
    await this.retry(async () => this.compose(['exec', '-T', 'redis', 'redis-cli', 'ping'], 20_000));
    for (const service of ['api', 'web', 'worker']) {
      await this.retry(async () => {
        const result = await this.compose(['ps', '--format', 'json', service], 20_000);
        if (!composeServiceHealthy(result.stdout, service))
          throw new Error(`SERVICE_NOT_HEALTHY_${service.toUpperCase()}`);
      });
    }
    await this.retry(async () => healthRequest(this.config.publicApiHealthUrl, targetVersion));
    await this.retry(async () => healthRequest(this.config.publicWebHealthUrl));
  }

  protected async retry(operation: () => Promise<unknown>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { return await operation(); } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 2_000)); }
    }
    throw lastError;
  }

  private async pruneBackups() {
    const entries = (await readdir(this.config.backupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isManagedBackupName(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries.slice(this.config.backupRetention)) await rm(join(this.config.backupRoot, entry.name), { recursive: true, force: true });
  }

  private async installedVersion() {
    const env = await readFile(this.config.envFile, 'utf8');
    const value = env.match(/^PE_COMMUNITY_VERSION=(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m);
    return parseVersion(value?.[1] ?? value?.[2] ?? value?.[3]).normalized;
  }

  private composePrefix() {
    return [
      'compose',
      '--env-file',
      this.config.envFile,
      '-f',
      this.config.composeFile,
      ...(this.config.composeOverrideFile
        ? ['-f', this.config.composeOverrideFile]
        : []),
    ];
  }

  private compose(args: readonly string[], timeoutMs: number) {
    return this.executor.run('docker', [...this.composePrefix(), ...args], { cwd: this.config.deploymentRoot, timeoutMs });
  }

  private async composeWithLogs(run: UpdateRun, args: readonly string[], timeoutMs: number, eventCode: string) {
    let logChain = Promise.resolve();
    let eventCount = 0;
    let truncated = false;
    const result = await this.executor.run('docker', [...this.composePrefix(), ...args], {
      cwd: this.config.deploymentRoot,
      timeoutMs,
      onOutput: ({ stream, chunk }) => {
        const message = sanitizeLog(chunk);
        if (!message) return;
        if (eventCount >= MAX_STREAM_EVENTS_PER_COMMAND) {
          if (!truncated) {
            truncated = true;
            logChain = logChain.then(() =>
              this.log(
                run,
                'WARNING',
                'COMMAND_OUTPUT_TRUNCATED',
                'Additional command output was omitted after the per-command safety limit.',
              ),
            );
          }
          return;
        }
        eventCount += 1;
        logChain = logChain.then(() => this.log(run, stream === 'stderr' ? 'WARNING' : 'INFO', eventCode, message));
      },
    });
    await logChain;
    return result;
  }

  private async phase(run: UpdateRun, phase: UpdatePhase, code: string, message: string) {
    const updated = transitionRun(run, phase);
    await this.store.saveRun(updated);
    await this.log(updated, 'INFO', code, message);
    return updated;
  }

  private async log(run: UpdateRun, level: UpdateLogLevel, eventCode: string, message: string) {
    const event: UpdateLogEvent = { sequence: run.lastSequence + 1, timestamp: new Date().toISOString(), level, phase: run.phase, eventCode, message: sanitizeLog(message) };
    run.lastSequence = event.sequence;
    await this.store.appendEvent(run.id, event);
    await this.store.saveRun(run);
  }

  private async cancelIfRequested(run: UpdateRun, beforeCancel?: () => Promise<unknown>) {
    const current = await this.store.loadRun(run.id);
    if (!current?.cancellationRequested) return run;
    if (beforeCancel) await beforeCancel();
    const cancelled = transitionRun(current, 'CANCELLED');
    await this.store.saveRun(cancelled);
    await this.log(cancelled, 'WARNING', 'UPDATE_CANCELLED', 'Update cancelled at a safe checkpoint.');
    throw new AgentError('CANCELLED');
  }
}

export class AgentError extends Error {
  constructor(readonly code: string, readonly status = 422) { super(code); }
}

function errorCode(error: unknown) {
  if (error instanceof AgentError || error instanceof ProvenanceError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)) return error.message;
  return 'UPDATE_EXECUTION_FAILED';
}

function validIdempotencyKey(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new AgentError('INVALID_IDEMPOTENCY_KEY', 400);
  return value;
}

function validInstallVersion(value: unknown) {
  try {
    return parseVersion(value).normalized;
  } catch {
    throw new AgentError('INVALID_VERSION', 400);
  }
}

async function writeVersion(path: string, source: string, version: string) {
  parseVersion(version);
  if (!/^PE_COMMUNITY_VERSION=/m.test(source)) throw new AgentError('CURRENT_VERSION_MISSING');
  const updated = source.replace(/^PE_COMMUNITY_VERSION=.*$/m, `PE_COMMUNITY_VERSION="${version}"`);
  await writeFile(path, updated, { mode: 0o600 });
}

async function healthRequest(url: string, expectedVersion?: string) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HEALTHCHECK_HTTP_${response.status}`);
  if (expectedVersion && response.headers.get('content-type')?.includes('application/json')) {
    const body = await response.json() as { version?: string };
    if (body.version && compareVersions(body.version, expectedVersion) !== 0) throw new Error('HEALTHCHECK_VERSION_MISMATCH');
  }
}

export function isManagedBackupName(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}$/.test(value);
}

function automaticRollbackAllowed(manifest: ReleaseManifest) {
  return ['NO_MIGRATION', 'BACKWARD_COMPATIBLE'].includes(
    manifest.database.migrationCompatibility,
  );
}

function composeServiceHealthy(output: string, service: string) {
  try {
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.some(
      (row) =>
        Boolean(row) &&
        typeof row === 'object' &&
        String((row as Record<string, unknown>).Service) === service &&
        String((row as Record<string, unknown>).State).toLowerCase() === 'running' &&
        String((row as Record<string, unknown>).Health).toLowerCase() === 'healthy',
    );
  } catch {
    return false;
  }
}

async function sha256File(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
