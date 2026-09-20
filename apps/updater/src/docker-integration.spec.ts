import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { UpdaterConfig } from './config.js';
import { UPDATER_PROTOCOL_VERSION, type ReleaseManifest } from './domain.js';
import type { ProvenanceVerifier } from './provenance.js';
import { ProcessCommandExecutor } from './executor.js';
import {
  createUpdaterHttpServer,
  listenUpdaterSocket,
  removeStaleSocket,
} from './http-server.js';
import { updaterSignature } from './ipc-auth.js';
import type { AgentRelease, ReleaseProvider } from './release.js';
import { AgentStore } from './store.js';
import { UpdaterAgent } from './updater.js';

test(
  'disposable host performs authenticated update and survives control-plane reconnect',
  { skip: process.env.PE_UPDATER_DOCKER_E2E !== '1', timeout: 300_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pe-community-updater-e2e-'));
    const deploymentRoot = join(root, 'deployment');
    const stateDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    const runtimeDir = join(root, 'run');
    const project = `pe-updater-e2e-${randomBytes(6).toString('hex')}`;
    const imagePrefix = `pe-updater-e2e-${randomBytes(6).toString('hex')}`;
    const fixtureImage = `${imagePrefix}-fixture:v1`;
    const composeFile = join(deploymentRoot, 'docker-compose.prod.yml');
    const envFile = join(deploymentRoot, '.env');
    const socketPath = join(runtimeDir, 'updater.sock');
    const apiPort = await freePort();
    const webPort = await freePort();
    const executor = new ProcessCommandExecutor();
    let server: ReturnType<typeof createUpdaterHttpServer> | null = null;
    await Promise.all([
      mkdir(join(deploymentRoot, 'deploy'), { recursive: true }),
      mkdir(stateDir),
      mkdir(backupRoot),
      mkdir(runtimeDir),
    ]);
    await writeFile(
      envFile,
      [
        'PE_COMMUNITY_VERSION="v1.0.0"',
        `TEST_IMAGE_PREFIX="${imagePrefix}"`,
        `API_PORT="${apiPort}"`,
        `WEB_PORT="${webPort}"`,
        'POSTGRES_PASSWORD="disposable-only-password"',
        'JWT_SECRET="disposable-only-jwt"',
        'PASSWORD_PEPPER="disposable-only-pepper"',
        'EMAIL_ENCRYPTION_KEY="disposable-only-email-key"',
        'WEB_ORIGIN="http://127.0.0.1"',
      ].join('\n') + '\n',
      { mode: 0o600 },
    );
    await writeFile(join(deploymentRoot, 'deploy', 'Caddyfile'), ':80 {}\n');
    await writeFile(composeFile, composeFixture(project));
    const compose = ['compose', '--env-file', envFile, '-f', composeFile];
    const repositories = {
      api: `${imagePrefix}-api`,
      web: `${imagePrefix}-web`,
      worker: `${imagePrefix}-worker`,
    };
    const tags = Object.values(repositories).flatMap((repository) => [
      `${repository}:v1.0.0`,
      `${repository}:v1.1.0`,
    ]);
    try {
      await executor.run(
        'docker',
        [
          'build',
          '--pull=false',
          '-t',
          fixtureImage,
          join(process.cwd(), 'test-fixture'),
        ],
        { timeoutMs: 120_000 },
      );
      for (const tag of tags)
        await executor.run('docker', ['tag', fixtureImage, tag]);
      await executor.run(
        'docker',
        [
          ...compose,
          'up',
          '-d',
          '--wait',
          'postgres',
          'redis',
          'api',
          'web',
          'worker',
        ],
        { cwd: deploymentRoot, timeoutMs: 120_000 },
      );
      const manifest: ReleaseManifest = {
        schemaVersion: 2,
        releaseContractVersion: 2,
        version: 'v1.1.0',
        releaseTag: 'v1.1.0',
        sourceCommit: 'd'.repeat(40),
        channel: 'stable',
        minimumVersion: 'v1.0.0',
        minimumUpdaterVersion: 'v1.1.0',
        images: {
          api: {
            repository: repositories.api,
            digest: `sha256:${'a'.repeat(64)}`,
          },
          web: {
            repository: repositories.web,
            digest: `sha256:${'b'.repeat(64)}`,
          },
          worker: {
            repository: repositories.worker,
            digest: `sha256:${'c'.repeat(64)}`,
          },
        },
        database: { migrationCompatibility: 'BACKWARD_COMPATIBLE' },
        supplyChain: { attestationPolicy: 'GITHUB_PROVENANCE_REQUIRED' },
        requiresManualAction: false,
      };
      const release: AgentRelease = {
        version: manifest.version,
        releaseUrl: 'https://example.invalid/disposable-release',
        publishedAt: new Date().toISOString(),
        notes: 'Disposable integration fixture',
        manifest,
        imageBundles: {
          api: new Uint8Array([1]),
          web: new Uint8Array([2]),
          worker: new Uint8Array([3]),
        },
        manifestProvenance: {
          service: 'manifest',
          digest: `sha256:${'f'.repeat(64)}`,
          policy: 'GITHUB_PROVENANCE_REQUIRED',
          verifiedAt: new Date(0).toISOString(),
          verifierVersion: '2.93.0',
          repository: 'Pona-Ekolo/PE-Community',
          workflow: '.github/workflows/publish-images.yml',
          result: 'VERIFIED',
        },
      };
      const releaseProvider: ReleaseProvider = {
        latest: async () => release,
        target: async () => release,
      };
      const config: UpdaterConfig = {
        updaterRoot: root,
        composeOverrideFile: null,
        deploymentRoot,
        composeFile,
        envFile,
        caddyFile: join(deploymentRoot, 'deploy', 'Caddyfile'),
        stateDir,
        backupRoot,
        socketPath,
        sharedSecret: 'integration-secret-'.padEnd(40, 'x'),
        previousSharedSecret: null,
        minimumFreeBytes: 1,
        backupRetention: 5,
        publicApiHealthUrl: `http://127.0.0.1:${apiPort}/api/v1/health`,
        publicWebHealthUrl: `http://127.0.0.1:${webPort}/login`,
        topology: 'single-host',
      };
      const store = new AgentStore(stateDir);
      const agent = new UpdaterAgent(
        config,
        store,
        new DockerFixtureExecutor(manifest),
        releaseProvider,
        repositories,
        new DockerFixtureProvenanceVerifier(),
      );
      await agent.initialize();
      server = createUpdaterHttpServer(config, agent);
      await listenUpdaterSocket(server, socketPath);
      const status = await ipcCall(config, 'GET', '/v1/status');
      assert.deepEqual(status, {
        agentVersion: '1.4.0',
        protocolVersion: 2,
        topology: 'single-host',
      });
      assert.equal(
        (await ipcCall(config, 'POST', '/v1/check', {})).version,
        'v1.1.0',
      );
      const started = await ipcCall(config, 'POST', '/v1/install', {
        version: 'v1.1.0',
        idempotencyKey: `integration-${randomUUID()}`,
      });
      const runId = String(started.id);
      await closeServer(server);
      server = null;
      const completed = await waitForTerminal(store, runId);
      assert.equal(
        completed.status,
        'COMPLETED',
        `${completed.failureCode}: ${completed.failureSummary}`,
      );
      await removeStaleSocket(socketPath);
      server = createUpdaterHttpServer(config, agent);
      await listenUpdaterSocket(server, socketPath);
      const resumed = await ipcCall<{
        run: { status: string };
        events: Array<{ sequence: number }>;
      }>(config, 'GET', `/v1/runs/${runId}?after=0`);
      assert.equal(resumed.run.status, 'COMPLETED');
      assert.ok(resumed.events.length > 5);
      assert.deepEqual(
        resumed.events.map((event: { sequence: number }) => event.sequence),
        [...resumed.events]
          .map((event: { sequence: number }) => event.sequence)
          .sort((left: number, right: number) => left - right),
      );
      await closeServer(server);
      server = null;
      const restartedStore = new AgentStore(stateDir);
      const restarted = new UpdaterAgent(
        config,
        restartedStore,
        new DockerFixtureExecutor(manifest),
        releaseProvider,
        repositories,
        new DockerFixtureProvenanceVerifier(),
      );
      await restarted.initialize();
      assert.equal((await restarted.run(runId)).run.status, 'COMPLETED');
      const backup = (await readdir(backupRoot))[0];
      assert.ok(backup);
      assert.ok(
        (await stat(join(backupRoot, backup, 'postgres.dump'))).size > 0,
      );
      assert.match(
        await readFile(
          join(backupRoot, backup, 'postgres.dump.sha256'),
          'utf8',
        ),
        /^sha256:|^[a-f0-9]{64}\s+postgres\.dump/m,
      );
      assert.match(
        await readFile(envFile, 'utf8'),
        /PE_COMMUNITY_VERSION="v1\.1\.0"/,
      );
      const health = (await fetch(config.publicApiHealthUrl).then((response) =>
        response.json(),
      )) as { version: string };
      assert.equal(health.version, 'v1.1.0');
    } finally {
      if (server) await closeServer(server).catch(() => undefined);
      await executor
        .run('docker', [...compose, 'down', '-v', '--remove-orphans'], {
          cwd: deploymentRoot,
          timeoutMs: 120_000,
        })
        .catch(() => undefined);
      await executor
        .run('docker', ['image', 'rm', '-f', ...tags, fixtureImage], {
          timeoutMs: 120_000,
        })
        .catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);

class DockerFixtureExecutor extends ProcessCommandExecutor {
  constructor(private readonly manifest: ReleaseManifest) {
    super();
  }

  override run(
    executable: string,
    args: readonly string[],
    options?: Parameters<ProcessCommandExecutor['run']>[2],
  ) {
    if (executable === 'docker' && args.includes('pull')) {
      options?.onOutput?.({
        stream: 'stdout',
        chunk: 'Disposable images already staged locally.\n',
      });
      return Promise.resolve({ stdout: 'staged\n', stderr: '' });
    }
    if (
      executable === 'docker' &&
      args.includes('image') &&
      args.includes('inspect')
    ) {
      const reference = String(args[2]);
      const service = reference.includes('-api:')
        ? 'api'
        : reference.includes('-web:')
          ? 'web'
          : 'worker';
      const image = this.manifest.images[service];
      return Promise.resolve({
        stdout: JSON.stringify([`${image.repository}@${image.digest}`]),
        stderr: '',
      });
    }
    return super.run(executable, args, options);
  }
}

class DockerFixtureProvenanceVerifier implements ProvenanceVerifier {
  async preflight() {
    return '2.98.0';
  }
  async verify(input: Parameters<ProvenanceVerifier['verify']>[0]) {
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

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve a test port.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function ipcCall<
  T extends Record<string, unknown> = Record<string, unknown>,
>(config: UpdaterConfig, method: 'GET' | 'POST', path: string, body?: unknown) {
  const payload =
    body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const timestamp = String(Date.now());
  const nonce = randomBytes(32).toString('hex');
  const contentDigest = createHash('sha256').update(payload).digest('hex');
  const signature = updaterSignature(config.sharedSecret, {
    protocol: String(UPDATER_PROTOCOL_VERSION),
    method,
    path,
    timestamp,
    nonce,
    contentDigest,
  });
  return new Promise<T>((resolve, reject) => {
    const outgoing = request(
      {
        socketPath: config.socketPath,
        path,
        method,
        headers: {
          'content-length': payload.length,
          'content-type': 'application/json',
          'x-updater-protocol': String(UPDATER_PROTOCOL_VERSION),
          'x-updater-timestamp': timestamp,
          'x-updater-nonce': nonce,
          'x-updater-content-sha256': contentDigest,
          'x-updater-signature': signature,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
          if ((response.statusCode ?? 500) >= 400)
            reject(new Error(String(value.code ?? response.statusCode)));
          else resolve(value);
        });
      },
    );
    outgoing.on('error', reject);
    if (payload.length) outgoing.write(payload);
    outgoing.end();
  });
}

async function waitForTerminal(store: AgentStore, runId: string) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const run = await store.loadRun(runId);
    if (
      run &&
      ['COMPLETED', 'FAILED', 'MANUAL_INTERVENTION_REQUIRED'].includes(
        run.status,
      )
    )
      return run;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Disposable updater run did not finish.');
}

function closeServer(server: ReturnType<typeof createUpdaterHttpServer>) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function composeFixture(project: string) {
  return `name: ${project}
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: pe
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: pe_community
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pe -d pe_community"]
      interval: 2s
      timeout: 2s
      retries: 30
  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 30
  api:
    image: \${TEST_IMAGE_PREFIX}-api:\${PE_COMMUNITY_VERSION}
    environment:
      PORT: "8080"
      PE_COMMUNITY_VERSION: \${PE_COMMUNITY_VERSION}
    ports: ["127.0.0.1:\${API_PORT}:8080"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/api/v1/health"]
      interval: 2s
      timeout: 2s
      retries: 30
  web:
    image: \${TEST_IMAGE_PREFIX}-web:\${PE_COMMUNITY_VERSION}
    environment:
      PORT: "3000"
      PE_COMMUNITY_VERSION: \${PE_COMMUNITY_VERSION}
    ports: ["127.0.0.1:\${WEB_PORT}:3000"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/login"]
      interval: 2s
      timeout: 2s
      retries: 30
  worker:
    image: \${TEST_IMAGE_PREFIX}-worker:\${PE_COMMUNITY_VERSION}
    environment:
      PORT: "3001"
      PE_COMMUNITY_VERSION: \${PE_COMMUNITY_VERSION}
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3001/health"]
      interval: 2s
      timeout: 2s
      retries: 30
`;
}
