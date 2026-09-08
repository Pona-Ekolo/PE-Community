import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWED_IMAGE_REPOSITORIES, type ReleaseManifest } from './domain.js';
import { runCli } from './cli.js';
import type { ProvenanceVerifier } from './provenance.js';
import type { AgentRelease, ReleaseProvider } from './release.js';

const sourceCommit = 'a'.repeat(40);
const manifest: ReleaseManifest = {
  schemaVersion: 2,
  releaseContractVersion: 1,
  version: 'v1.2.7',
  releaseTag: 'v1.2.7',
  channel: 'stable',
  minimumVersion: 'v1.2.3',
  minimumUpdaterVersion: 'v1.4.0',
  images: {
    api: {
      repository: ALLOWED_IMAGE_REPOSITORIES.api,
      digest: `sha256:${'1'.repeat(64)}`,
    },
    web: {
      repository: ALLOWED_IMAGE_REPOSITORIES.web,
      digest: `sha256:${'2'.repeat(64)}`,
    },
    worker: {
      repository: ALLOWED_IMAGE_REPOSITORIES.worker,
      digest: `sha256:${'3'.repeat(64)}`,
    },
  },
  database: { migrationCompatibility: 'FORWARD_ONLY' },
  supplyChain: { attestationPolicy: 'GITHUB_PROVENANCE_REQUIRED' },
  requiresManualAction: false,
  sourceCommit,
};

test('verify-release reports only authenticated immutable release metadata', async () => {
  const output = outputCollector();
  const code = await runCli(['verify-release', 'v1.2.7', '--json'], {
    releases: releaseProvider(),
    provenance: provenanceVerifier(),
    output,
    writePlan: noPlanWrite,
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output.lines[0] ?? '{}'), {
    release: 'v1.2.7',
    sourceCommit,
    releaseContractVersion: 1,
    policy: { strategy: 'FORWARD_ONLY', requiresManualAction: false },
    images: manifest.images,
  });
  assert.equal(output.errors.length, 0);
});

test('verify-release produces a Compose override that consumes exact authenticated digests', async () => {
  const output = outputCollector();
  let plan = '';
  const code = await runCli(
    ['verify-release', 'v1.2.7', '--output-plan', '/tmp/verified-images.yml'],
    {
      releases: releaseProvider(),
      provenance: provenanceVerifier(),
      output,
      writePlan: async (_path, content) => {
        plan = content;
      },
    },
  );
  assert.equal(code, 0);
  for (const image of Object.values(manifest.images))
    assert.match(plan, new RegExp(`${image.repository}@${image.digest}`));
  assert.doesNotMatch(plan, /:v1\.2\.7/);
});

test('verify-release fails closed for manifest, image provenance, and manual-action policy failures', async () => {
  const output = outputCollector();
  const failures = [
    {
      releases: rejectingReleaseProvider('MANIFEST_ATTESTATION_INVALID'),
      provenance: provenanceVerifier(),
    },
    {
      releases: releaseProvider(),
      provenance: provenanceVerifier('PROVENANCE_SIGNATURE_INVALID'),
    },
    {
      releases: releaseProvider({ requiresManualAction: true }),
      provenance: provenanceVerifier(),
    },
  ];
  for (const dependencies of failures) {
    output.lines.length = 0;
    output.errors.length = 0;
    assert.equal(
      await runCli(['verify-release', 'v1.2.7'], {
        ...dependencies,
        output,
        writePlan: noPlanWrite,
      }),
      1,
    );
    assert.equal(output.lines.length, 0);
    assert.match(output.errors[0] ?? '', /Release verification failed:/);
  }
});

test('verify-release does not require updater configuration, IPC, Docker, or systemd', async () => {
  const output = outputCollector();
  const calls: string[] = [];
  const code = await runCli(['verify-release', 'v1.2.7'], {
    releases: releaseProvider(calls),
    provenance: provenanceVerifier(undefined, calls),
    output,
    writePlan: noPlanWrite,
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, ['release:v1.2.7', 'api', 'web', 'worker']);
});

function releaseProvider(
  overrides: Partial<ReleaseManifest> | string[] = {},
): ReleaseProvider {
  const calls = Array.isArray(overrides) ? overrides : null;
  const value = calls ? manifest : { ...manifest, ...overrides };
  return {
    async latest() {
      return release(value);
    },
    async target(version) {
      calls?.push(`release:${version}`);
      return release(value);
    },
  };
}

function rejectingReleaseProvider(code: string): ReleaseProvider {
  return {
    async latest() {
      throw new Error(code);
    },
    async target() {
      throw new Error(code);
    },
  };
}

function release(value: ReleaseManifest): AgentRelease {
  return {
    version: value.version,
    releaseUrl: 'https://example.invalid/release',
    publishedAt: '2026-09-08T00:00:00Z',
    notes: '',
    manifest: value,
    manifestProvenance: {
      service: 'manifest',
      digest: `sha256:${'0'.repeat(64)}`,
      policy: 'GITHUB_PROVENANCE_REQUIRED',
      verifiedAt: '2026-09-08T00:00:00Z',
      verifierVersion: '2.93.0',
      repository: 'Pona-Ekolo/PE-Community',
      workflow: '.github/workflows/publish-images.yml',
      result: 'VERIFIED',
    },
  };
}

function provenanceVerifier(
  failure?: string,
  calls: string[] = [],
): ProvenanceVerifier {
  return {
    async preflight() {
      return '2.93.0';
    },
    async verify(input) {
      calls.push(input.service);
      if (failure) throw new Error(failure);
      return {
        service: input.service,
        digest: input.digest,
        policy: 'GITHUB_PROVENANCE_REQUIRED',
        verifiedAt: '2026-09-08T00:00:00Z',
        verifierVersion: '2.93.0',
        repository: 'Pona-Ekolo/PE-Community',
        workflow: '.github/workflows/publish-images.yml',
        result: 'VERIFIED',
      };
    },
  };
}

function outputCollector() {
  return {
    lines: [] as string[],
    errors: [] as string[],
    log(value: string) {
      this.lines.push(value);
    },
    error(value: string) {
      this.errors.push(value);
    },
  };
}

async function noPlanWrite() {
  throw new Error('UNEXPECTED_PLAN_WRITE');
}
