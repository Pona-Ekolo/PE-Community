import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { UpdaterConfig } from './config.js';
import {
  ALLOWED_IMAGE_REPOSITORIES,
  type ReleaseManifest,
  type UpdateRun,
} from './domain.js';
import { ProcessCommandExecutor, type CommandExecutor } from './executor.js';
import type { AgentRelease, ReleaseProvider } from './release.js';
import type { ProvenanceVerifier } from './provenance.js';
import { ProvenanceError } from './provenance.js';
import { AgentStore } from './store.js';
import { isManagedBackupName, UpdaterAgent } from './updater.js';

const manifest: ReleaseManifest = {
  schemaVersion: 2,
  releaseContractVersion: 2,
  version: 'v1.1.0',
  channel: 'stable',
  minimumVersion: 'v1.0.0',
  minimumUpdaterVersion: 'v1.1.0',
  releaseTag: 'v1.1.0',
  sourceCommit: 'd'.repeat(40),
  images: {
    api: {
      repository: ALLOWED_IMAGE_REPOSITORIES.api,
      digest: `sha256:${'a'.repeat(64)}`,
    },
    web: {
      repository: ALLOWED_IMAGE_REPOSITORIES.web,
      digest: `sha256:${'b'.repeat(64)}`,
    },
    worker: {
      repository: ALLOWED_IMAGE_REPOSITORIES.worker,
      digest: `sha256:${'c'.repeat(64)}`,
    },
  },
  database: { migrationCompatibility: 'BACKWARD_COMPATIBLE' },
  supplyChain: { attestationPolicy: 'GITHUB_PROVENANCE_REQUIRED' },
  requiresManualAction: false,
};

test('invalid install input is rejected as a client error before execution', async () => {
  const fixture = await fixtureAgent();
  await assert.rejects(
    () =>
      fixture.agent.install({
        version: 'latest',
        idempotencyKey: 'valid-idempotency-key',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'INVALID_VERSION' &&
      'status' in error &&
      error.status === 400,
  );
});

test('the permanent validation fixture can never become an installation target', async () => {
  const fixture = await fixtureAgent();
  await assert.rejects(
    () =>
      fixture.agent.install({
        version: 'v0.0.0',
        idempotencyKey: 'validation-fixture-key',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'VALIDATION_FIXTURE_NOT_INSTALLABLE' &&
      'status' in error &&
      error.status === 400,
  );
  assert.equal(fixture.executor.calls.length, 0);
});

test('duplicate install idempotency key returns the same run and never starts a second execution', async () => {
  const fixture = await fixtureAgent();
  const first = await fixture.agent.install({
    version: 'v1.1.0',
    idempotencyKey: 'test-idempotency-key',
  });
  const second = await fixture.agent.install({
    version: 'v1.1.0',
    idempotencyKey: 'test-idempotency-key',
  });
  assert.equal(second.id, first.id);
  await waitForTerminal(fixture.store, first.id);
});

test('a distinct concurrent install is rejected by the host lock', async () => {
  const fixture = await fixtureAgent();
  const first = await fixture.agent.install({
    version: 'v1.1.0',
    idempotencyKey: `first-${randomUUID()}`,
  });
  await assert.rejects(
    () =>
      fixture.agent.install({
        version: 'v1.1.0',
        idempotencyKey: `second-${randomUUID()}`,
      }),
    /UPDATE_IN_PROGRESS/,
  );
  await waitForTerminal(fixture.store, first.id);
  await waitForLockReleased(fixture.store);
});

test('agent executes only fixed docker argv and completes fake update', async () => {
  const fixture = await fixtureAgent();
  const run = await fixture.agent.install({
    version: 'v1.1.0',
    idempotencyKey: 'another-test-key',
  });
  const completed = await waitForTerminal(fixture.store, run.id);
  assert.equal(
    completed.status,
    'COMPLETED',
    `${completed.failureCode}: ${completed.failureSummary}`,
  );
  assert.ok(
    fixture.executor.calls.some(
      (call) => call.args.includes('migrate') && call.args.includes('deploy'),
    ),
  );
  assert.ok(
    fixture.executor.calls.every((call) => call.executable === 'docker'),
  );
  assert.equal(
    (await readFile(fixture.config.envFile, 'utf8')).match(
      /PE_COMMUNITY_VERSION="v1.1.0"/,
    )?.[0],
    'PE_COMMUNITY_VERSION="v1.1.0"',
  );
});

test('idempotency lookup survives later completed runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pe-updater-store-test-'));
  const store = new AgentStore(root);
  await store.initialize();
  const first = completedRun('historical-idempotency-key');
  const second = completedRun('newer-idempotency-key');
  await store.saveRun(first);
  await store.saveRun(second);
  assert.equal(
    (await store.findByIdempotencyKey(first.idempotencyKey))?.id,
    first.id,
  );
});

test('health checks reject a service without a healthy Compose state', async () => {
  for (const service of ['api', 'web', 'worker'] as const) {
    const fixture = await fixtureAgent();
    fixture.executor.unhealthyService = service;
    await assert.rejects(
      () => fixture.agent.checkHealth('v1.1.0'),
      new RegExp(`SERVICE_NOT_HEALTHY_${service.toUpperCase()}`),
    );
  }
});

test('public API and Web health failures are rejected independently', async () => {
  const api = await fixtureAgent();
  api.config.publicApiHealthUrl = 'http://127.0.0.1:1/api/v1/health';
  await assert.rejects(() => api.agent.checkHealth('v1.1.0'));

  const web = await fixtureAgent();
  web.config.publicApiHealthUrl =
    'data:application/json,%7B%22version%22%3A%22v1.1.0%22%7D';
  web.config.publicWebHealthUrl = 'http://127.0.0.1:1/login';
  await assert.rejects(() => web.agent.checkHealth('v1.1.0'));
});

test('preflight fails closed for disk, Docker, and Compose failures', async () => {
  const disk = await fixtureAgent();
  disk.config.minimumFreeBytes = Number.MAX_SAFE_INTEGER;
  await assert.rejects(() => disk.agent.checkPreflight(), /INSUFFICIENT_DISK/);

  const docker = await fixtureAgent();
  docker.executor.failureArguments = ['info'];
  await assert.rejects(
    () => docker.agent.checkPreflight(),
    /Injected command failure/,
  );

  const compose = await fixtureAgent();
  compose.executor.failureArguments = ['compose', 'version'];
  await assert.rejects(
    () => compose.agent.checkPreflight(),
    /Injected command failure/,
  );
});

test('dependency readiness fails closed for PostgreSQL and Redis', async () => {
  for (const argumentsToFail of [['pg_isready'], ['redis-cli', 'ping']]) {
    const fixture = await fixtureAgent();
    fixture.executor.failureArguments = argumentsToFail;
    await assert.rejects(
      () => fixture.agent.checkHealth('v1.1.0'),
      /Injected command failure/,
    );
  }
});

test('backup capture resolves only after the complete output file is closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pe-updater-capture-test-'));
  const outputPath = join(root, 'capture.bin');
  const expectedSize = 2 * 1024 * 1024;
  await new ProcessCommandExecutor().capture(
    process.execPath,
    ['-e', `process.stdout.write(Buffer.alloc(${expectedSize}, 97))`],
    outputPath,
    { timeoutMs: 10_000 },
  );
  assert.equal((await readFile(outputPath)).length, expectedSize);
});

test('backup retention recognizes only updater-owned directory names', () => {
  assert.equal(
    isManagedBackupName(`2026-08-30T01-02-03-004Z-${randomUUID()}`),
    true,
  );
  assert.equal(isManagedBackupName('operator-manual-backup'), false);
  assert.equal(isManagedBackupName('../outside'), false);
});

test('an unavailable backup destination fails before pull and releases the lock', async () => {
  const fixture = await fixtureAgent();
  await rm(fixture.config.backupRoot, { recursive: true });
  await writeFile(fixture.config.backupRoot, 'not a directory');
  const run = await fixture.agent.install({
    version: 'v1.1.0',
    idempotencyKey: `backup-destination-${randomUUID()}`,
  });
  const failed = await waitForTerminal(fixture.store, run.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(
    fixture.executor.calls.some((call) => call.args.includes('pull')),
    false,
  );
  assert.match(await readFile(fixture.config.envFile, 'utf8'), /v1\.0\.0/);
  await waitForLockReleased(fixture.store);
});

test('restart before migration restores installed version and produces a retryable failure', async () => {
  const fixture = await fixtureAgent(false);
  await fixture.store.initialize();
  const run = activeRun('PULLING');
  await fixture.store.saveRun(run);
  await fixture.store.acquireLock(run.id);
  await writeFile(
    fixture.config.envFile,
    (await readFile(fixture.config.envFile, 'utf8')).replace(
      'v1.0.0',
      'v1.1.0',
    ),
  );
  await fixture.agent.initialize();
  const recovered = await fixture.store.loadRun(run.id);
  assert.equal(recovered?.status, 'FAILED');
  assert.equal(recovered?.failureCode, 'AGENT_RESTART_SAFE_TO_RETRY');
  assert.match(await readFile(fixture.config.envFile, 'utf8'), /v1\.0\.0/);
});

test('restart during migration inspects status and requires manual intervention', async () => {
  const fixture = await fixtureAgent(false);
  await fixture.store.initialize();
  const run = activeRun('MIGRATING');
  await fixture.store.saveRun(run);
  await fixture.store.acquireLock(run.id);
  await fixture.agent.initialize();
  const recovered = await fixture.store.loadRun(run.id);
  assert.equal(recovered?.status, 'MANUAL_INTERVENTION_REQUIRED');
  assert.equal(recovered?.failureCode, 'AGENT_RESTART_DURING_MIGRATION');
  assert.ok(
    fixture.executor.calls.some(
      (call) => call.args.includes('migrate') && call.args.includes('status'),
    ),
  );
});

test('restart during health check completes only after target health is proven', async () => {
  const fixture = await fixtureAgent(false);
  await fixture.store.initialize();
  const run = activeRun('HEALTHCHECK');
  await fixture.store.saveRun(run);
  await fixture.store.acquireLock(run.id);
  await fixture.agent.initialize();
  assert.equal((await fixture.store.loadRun(run.id))?.status, 'COMPLETED');
});

test('restart during rollback verifies the previous release before closing failed', async () => {
  const fixture = await fixtureAgent(false);
  await fixture.store.initialize();
  const run = activeRun('ROLLING_BACK');
  await fixture.store.saveRun(run);
  await fixture.store.acquireLock(run.id);
  await fixture.agent.initialize();
  const recovered = await fixture.store.loadRun(run.id);
  assert.equal(recovered?.status, 'FAILED');
  assert.equal(recovered?.rollbackStatus, 'COMPLETED');
});

test('cancellation is accepted only in declared safe phases and denied once migration begins', async () => {
  const fixture = await fixtureAgent(false);
  await fixture.store.initialize();
  for (const phase of ['PENDING', 'PREFLIGHT', 'PULLING'] as const) {
    const run = activeRun(phase);
    await fixture.store.saveRun(run);
    const cancelled = await fixture.agent.cancel(run.id);
    assert.equal(cancelled.cancellationRequested, true, phase);
  }

  for (const phase of [
    'BACKUP',
    'VERIFYING',
    'MIGRATING',
    'DEPLOYING',
    'HEALTHCHECK',
  ] as const) {
    const run = activeRun(phase);
    await fixture.store.saveRun(run);
    await assert.rejects(
      () => fixture.agent.cancel(run.id),
      /CANCELLATION_UNSAFE/,
      phase,
    );
  }
});

test('failure matrix preserves safe state across backup, pull, verification, and migration failures', async () => {
  for (const scenario of [
    { name: 'backup', capture: true },
    { name: 'restore-validation', args: ['pg_restore', '--list'] },
    { name: 'pull', args: ['pull'] },
    { name: 'verification', digestMismatch: true },
    { name: 'migration', args: ['migrate', 'deploy'] },
  ]) {
    const fixture = await fixtureAgent();
    fixture.executor.captureFailure = scenario.capture ?? false;
    fixture.executor.failureArguments = scenario.args ?? [];
    fixture.executor.digestMismatch = scenario.digestMismatch ?? false;
    const run = await fixture.agent.install({
      version: 'v1.1.0',
      idempotencyKey: `failure-${scenario.name}-${randomUUID()}`,
    });
    const failed = await waitForTerminal(fixture.store, run.id);
    assert.equal(failed.status, 'FAILED', scenario.name);
    assert.match(await readFile(fixture.config.envFile, 'utf8'), /v1\.0\.0/);
    assert.ok((await readdir(fixture.config.backupRoot)).length > 0);
    await waitForLockReleased(fixture.store);
  }
});

test('health failure rolls back only backward-compatible releases', async () => {
  const compatible = await fixtureAgent();
  compatible.agent.unhealthyVersion = 'v1.1.0';
  const compatibleRun = await compatible.agent.install({
    version: 'v1.1.0',
    idempotencyKey: `compatible-${randomUUID()}`,
  });
  const rolledBack = await waitForTerminal(compatible.store, compatibleRun.id);
  assert.equal(rolledBack.status, 'FAILED');
  assert.equal(rolledBack.rollbackStatus, 'COMPLETED');
  assert.match(await readFile(compatible.config.envFile, 'utf8'), /v1\.0\.0/);

  const forwardOnlyManifest: ReleaseManifest = {
    ...manifest,
    database: { migrationCompatibility: 'FORWARD_ONLY' },
  };
  const forwardOnly = await fixtureAgent(true, forwardOnlyManifest);
  forwardOnly.agent.unhealthyVersion = 'v1.1.0';
  const forwardRun = await forwardOnly.agent.install({
    version: 'v1.1.0',
    idempotencyKey: `forward-${randomUUID()}`,
  });
  const manual = await waitForTerminal(forwardOnly.store, forwardRun.id);
  assert.equal(manual.status, 'MANUAL_INTERVENTION_REQUIRED');
  assert.equal(manual.rollbackStatus, 'UNSAFE');
});

test('digest-only legacy release requires manual installation before pull', async () => {
  const legacy: ReleaseManifest = {
    ...manifest,
    supplyChain: { attestationPolicy: 'DIGEST_ONLY' },
  };
  const fixture = await fixtureAgent(true, legacy);
  const run = await fixture.agent.install({
    version: 'v1.1.0',
    idempotencyKey: `attestation-${randomUUID()}`,
  });
  const manual = await waitForTerminal(fixture.store, run.id);
  assert.equal(manual.status, 'MANUAL_INTERVENTION_REQUIRED');
  assert.equal(manual.failureCode, 'LEGACY_RELEASE_MANUAL_REQUIRED');
  assert.equal(
    fixture.executor.calls.some((call) => call.args.includes('pull')),
    false,
  );
});

test('provenance failure stops after pull and before migration or deployment', async () => {
  const fixture = await fixtureAgent();
  fixture.provenance.failureCode = 'PROVENANCE_SIGNATURE_INVALID';
  const run = await fixture.agent.install({
    version: 'v1.1.0',
    idempotencyKey: `provenance-failure-${randomUUID()}`,
  });
  const failed = await waitForTerminal(fixture.store, run.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureCode, 'PROVENANCE_SIGNATURE_INVALID');
  assert.equal(
    fixture.executor.calls.some((call) => call.args.includes('pull')),
    true,
  );
  assert.equal(
    fixture.executor.calls.some((call) => call.args.includes('migrate')),
    false,
  );
  assert.equal(
    fixture.executor.calls.some((call) => call.args.includes('up')),
    false,
  );
  assert.match(await readFile(fixture.config.envFile, 'utf8'), /v1\.0\.0/);
  const events = await fixture.store.events(run.id);
  assert.ok(
    events.some(
      (event) =>
        event.eventCode === 'SYSTEM_UPDATE_PROVENANCE_VERIFICATION_FAILED',
    ),
  );
});

test('manifest attestation failure stops before image pull or deployment mutation', async () => {
  const fixture = await fixtureAgent(
    true,
    manifest,
    new Error('MANIFEST_ATTESTATION_INVALID'),
  );
  const run = await fixture.agent.install({
    version: 'v1.1.0',
    idempotencyKey: `manifest-attestation-failure-${randomUUID()}`,
  });
  const failed = await waitForTerminal(fixture.store, run.id);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureCode, 'MANIFEST_ATTESTATION_INVALID');
  assert.equal(
    fixture.executor.calls.some((call) => call.args.includes('pull')),
    false,
  );
  assert.equal(
    fixture.executor.calls.some((call) => call.args.includes('migrate')),
    false,
  );
  assert.equal(
    fixture.executor.calls.some((call) => call.args.includes('up')),
    false,
  );
});

async function fixtureAgent(
  initialize = true,
  releaseManifest: ReleaseManifest = manifest,
  releaseFailure?: Error,
) {
  const root = await mkdtemp(join(tmpdir(), 'pe-updater-test-'));
  const deploymentRoot = join(root, 'deployment');
  const stateDir = join(root, 'state');
  const backupRoot = join(root, 'backups');
  await Promise.all([
    mkdir(join(deploymentRoot, 'deploy'), { recursive: true }),
    mkdir(stateDir),
    mkdir(backupRoot),
  ]);
  const envFile = join(deploymentRoot, '.env');
  const composeFile = join(deploymentRoot, 'docker-compose.prod.yml');
  const caddyFile = join(deploymentRoot, 'deploy', 'Caddyfile');
  await writeFile(
    envFile,
    'PE_COMMUNITY_VERSION="v1.0.0"\nPOSTGRES_PASSWORD=x\nJWT_SECRET=x\nPASSWORD_PEPPER=x\nEMAIL_ENCRYPTION_KEY=x\nWEB_ORIGIN=https://example.test\n',
  );
  await writeFile(composeFile, 'services: {}\n');
  await writeFile(caddyFile, ':80 {}\n');
  const config: UpdaterConfig = {
    updaterRoot: root,
    deploymentRoot,
    stateDir,
    backupRoot,
    envFile,
    composeFile,
    composeOverrideFile: null,
    caddyFile,
    socketPath: join(root, 'updater.sock'),
    sharedSecret: 'x'.repeat(32),
    previousSharedSecret: null,
    minimumFreeBytes: 1,
    backupRetention: 5,
    publicApiHealthUrl: 'https://example.test/health',
    publicWebHealthUrl: 'https://example.test/login',
    topology: 'single-host',
  };
  const store = new AgentStore(stateDir);
  const executor = new FakeExecutor(releaseManifest);
  const release: AgentRelease = {
    version: releaseManifest.version,
    releaseUrl: 'https://example.test/release',
    publishedAt: new Date(0).toISOString(),
    notes: 'Test',
    manifest: releaseManifest,
    imageBundles: {
      api: new Uint8Array([1]),
      web: new Uint8Array([2]),
      worker: new Uint8Array([3]),
    },
    manifestProvenance: verifiedManifestProvenance(),
  };
  const releases: ReleaseProvider = {
    latest: async () => release,
    target: async () => {
      if (releaseFailure) throw releaseFailure;
      return release;
    },
  };
  const provenance = new FakeProvenanceVerifier();
  const agent = new TestUpdaterAgent(
    config,
    store,
    executor,
    releases,
    ALLOWED_IMAGE_REPOSITORIES,
    provenance,
  );
  if (initialize) await agent.initialize();
  return { agent, store, executor, provenance, config };
}

function verifiedManifestProvenance() {
  return {
    service: 'manifest' as const,
    digest: `sha256:${'f'.repeat(64)}`,
    policy: 'GITHUB_PROVENANCE_REQUIRED' as const,
    verifiedAt: new Date(0).toISOString(),
    verifierVersion: '2.93.0',
    repository: 'Pona-Ekolo/PE-Community' as const,
    workflow: '.github/workflows/publish-images.yml' as const,
    result: 'VERIFIED' as const,
  };
}

class FakeExecutor implements CommandExecutor {
  constructor(private readonly releaseManifest = manifest) {}
  calls: Array<{ executable: string; args: readonly string[] }> = [];
  unhealthyService: 'api' | 'web' | 'worker' | null = null;
  captureFailure = false;
  digestMismatch = false;
  failureArguments: string[] = [];
  async run(executable: string, args: readonly string[]) {
    this.calls.push({ executable, args });
    if (
      this.failureArguments.length &&
      this.failureArguments.every((argument) => args.includes(argument))
    ) {
      throw new Error(
        `Injected command failure: ${this.failureArguments.join(' ')}`,
      );
    }
    if (args.includes('image') && args.includes('inspect')) {
      const reference = args[2];
      const service = reference.includes('-api:')
        ? 'api'
        : reference.includes('-web:')
          ? 'web'
          : 'worker';
      const digest = this.digestMismatch
        ? `sha256:${'f'.repeat(64)}`
        : this.releaseManifest.images[service].digest;
      return {
        stdout: JSON.stringify([
          `${ALLOWED_IMAGE_REPOSITORIES[service]}@${digest}`,
        ]),
        stderr: '',
      };
    }
    if (
      args.includes('ps') &&
      args.includes('--format') &&
      args.at(-2) === 'json'
    ) {
      const service = String(args.at(-1));
      return {
        stdout:
          this.unhealthyService !== service
            ? JSON.stringify([
                { Service: service, State: 'running', Health: 'healthy' },
              ])
            : '',
        stderr: '',
      };
    }
    return { stdout: '{}', stderr: '' };
  }
  async capture(
    _executable: string,
    _args: readonly string[],
    outputPath: string,
  ) {
    if (this.captureFailure) throw new Error('Injected backup failure');
    await writeFile(outputPath, 'fake pg dump');
    return { stderr: '' };
  }
}

class FakeProvenanceVerifier implements ProvenanceVerifier {
  failureCode: string | null = null;
  async preflight() {
    return '2.98.0';
  }
  async verify(input: Parameters<ProvenanceVerifier['verify']>[0]) {
    if (this.failureCode) throw new ProvenanceError(this.failureCode);
    return {
      service: input.service,
      digest: input.digest,
      policy: 'GITHUB_PROVENANCE_REQUIRED' as const,
      verifiedAt: new Date(0).toISOString(),
      verifierVersion: '2.98.0',
      repository: 'Pona-Ekolo/PE-Community' as const,
      workflow: '.github/workflows/publish-images.yml' as const,
      result: 'VERIFIED' as const,
    };
  }
}

class TestUpdaterAgent extends UpdaterAgent {
  unhealthyVersion: string | null = null;
  protected override async retry(operation: () => Promise<unknown>) {
    return operation();
  }
  checkHealth(targetVersion: string) {
    return super.healthChecks(targetVersion);
  }
  checkPreflight() {
    return super.preflight();
  }
  protected override async healthChecks(targetVersion: string) {
    if (targetVersion === this.unhealthyVersion)
      throw new Error(`Injected unhealthy version: ${targetVersion}`);
  }
  protected override async preflight() {}
}

async function waitForTerminal(store: AgentStore, id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await store.loadRun(id);
    if (
      run &&
      [
        'COMPLETED',
        'FAILED',
        'MANUAL_INTERVENTION_REQUIRED',
        'CANCELLED',
      ].includes(run.status)
    )
      return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fake update did not finish.');
}

async function waitForLockReleased(store: AgentStore) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await store.acquireLock(randomUUID());
      await store.releaseLock();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('Updater lock was not released.');
}

function completedRun(idempotencyKey: string): UpdateRun {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    idempotencyKey,
    installedVersion: 'v1.0.0',
    targetVersion: 'v1.1.0',
    status: 'COMPLETED',
    phase: 'COMPLETED',
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    failureCode: null,
    failureSummary: null,
    rollbackStatus: 'NOT_REQUIRED',
    releaseMetadataSnapshot: manifest,
    provenanceResults: [],
    lastSequence: 1,
    cancellationRequested: false,
  };
}

function activeRun(phase: UpdateRun['phase']): UpdateRun {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    idempotencyKey: `recovery-${randomUUID()}`,
    installedVersion: 'v1.0.0',
    targetVersion: 'v1.1.0',
    status: phase,
    phase,
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: null,
    failureCode: null,
    failureSummary: null,
    rollbackStatus: 'AVAILABLE',
    releaseMetadataSnapshot: manifest,
    provenanceResults: [],
    lastSequence: 0,
    cancellationRequested: false,
  };
}
