import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED_IMAGE_REPOSITORIES,
  VALIDATION_FIXTURE_VERSION,
  compareVersions,
  isValidationFixtureVersion,
  sanitizeLog,
  transitionRun,
  validateManifest,
  type UpdateRun,
} from './domain.js';

const run: UpdateRun = {
  id: '00000000-0000-4000-8000-000000000000',
  idempotencyKey: 'idempotency-key-1',
  installedVersion: 'v1.0.0',
  targetVersion: 'v1.1.0',
  status: 'PENDING',
  phase: 'PENDING',
  createdAt: new Date(0).toISOString(),
  startedAt: null,
  completedAt: null,
  failureCode: null,
  failureSummary: null,
  rollbackStatus: 'NOT_REQUIRED',
  releaseMetadataSnapshot: null,
  provenanceResults: [],
  lastSequence: 0,
  cancellationRequested: false,
};

test('state machine permits only explicit update transitions', () => {
  const preflight = transitionRun(run, 'PREFLIGHT', new Date(1));
  assert.equal(preflight.startedAt, new Date(1).toISOString());
  assert.throws(
    () => transitionRun(preflight, 'DEPLOYING'),
    /Invalid update transition/,
  );
  assert.equal(
    transitionRun(preflight, 'FAILED', new Date(2)).completedAt,
    new Date(2).toISOString(),
  );
});

test('strict semantic versions compare without accepting prerelease or shell input', () => {
  assert.equal(VALIDATION_FIXTURE_VERSION, 'v0.0.0');
  assert.equal(isValidationFixtureVersion('v0.0.0'), true);
  assert.equal(isValidationFixtureVersion('v0.0.1'), false);
  assert.equal(compareVersions('v0.0.0', 'v0.1.0'), -1);
  assert.equal(compareVersions('v1.2.3', 'v1.2.4'), -1);
  assert.equal(compareVersions('v2.0.0', 'v1.99.99'), 1);
  assert.throws(
    () => compareVersions('v1.2.3;id', 'v1.2.4'),
    /INVALID_VERSION/,
  );
  assert.throws(() => compareVersions('latest', 'v1.2.4'), /INVALID_VERSION/);
  for (const value of [
    '1.2.3',
    'v01.2.3',
    'v1.2.3-rc.1',
    '../../v1.2.3',
    'v1.2.3 ',
    'https://example.test/v1.2.3',
    `v1.2.3${'0'.repeat(200)}`,
  ]) {
    assert.throws(() => compareVersions(value, 'v1.2.4'), /INVALID_VERSION/);
  }
});

test('manifest requires allowlisted repositories and immutable sha256 digests', () => {
  const manifest = {
    schemaVersion: 2,
    releaseContractVersion: 2,
    version: 'v1.2.0',
    releaseTag: 'v1.2.0',
    sourceCommit: 'd'.repeat(40),
    channel: 'stable',
    minimumVersion: 'v1.0.0',
    minimumUpdaterVersion: 'v1.0.0',
    images: Object.fromEntries(
      Object.entries(ALLOWED_IMAGE_REPOSITORIES).map(([key, repository]) => [
        key,
        { repository, digest: `sha256:${'a'.repeat(64)}` },
      ]),
    ),
    database: { migrationCompatibility: 'BACKWARD_COMPATIBLE' },
    supplyChain: { attestationPolicy: 'DIGEST_ONLY' },
    requiresManualAction: false,
  };
  assert.equal(
    validateManifest(manifest).images.api.repository,
    ALLOWED_IMAGE_REPOSITORIES.api,
  );
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        images: {
          ...manifest.images,
          api: { ...manifest.images.api, repository: 'evil.invalid/api' },
        },
      }),
    /MANIFEST_IMAGE_INVALID/,
  );
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        images: {
          ...manifest.images,
          api: { ...manifest.images.api, digest: 'latest' },
        },
      }),
    /MANIFEST_IMAGE_INVALID/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, command: 'docker ps' }),
    /MANIFEST_UNKNOWN_FIELD/,
  );
  assert.throws(
    () =>
      validateManifest({
        ...manifest,
        images: { ...manifest.images, extra: manifest.images.api },
      }),
    /MANIFEST_UNKNOWN_FIELD/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, schemaVersion: 999 }),
    /MANIFEST_INVALID/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, releaseTag: 'v1.2.1' }),
    /PROVENANCE_RELEASE_TAG_MISMATCH/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, sourceCommit: 'short' }),
    /MANIFEST_SOURCE_INVALID/,
  );
});

test('log sanitizer removes secrets, bearer tokens, and injected newlines', () => {
  const sanitized = sanitizeLog(
    'DATABASE_URL=postgres://private\nAuthorization: Bearer abc.def SECRET_KEY=hidden',
  );
  assert.doesNotMatch(sanitized, /private|abc\.def|hidden|\n/);
  assert.match(sanitized, /<redacted>/);
});

test('log sanitizer handles credential variants, ANSI escapes, JSON auth, and length bounds', () => {
  const sanitized = sanitizeLog(
    `\u001b[31mPASSWORD=two words\nJWT_SECRET=value\nDATABASE_URL=postgres://user:password@db/name\nAuthorization: Bearer abc.def\nCookie: session=value\n{"auth":"base64secret","SMTP_PASSWORD":"mail","UPDATER_SHARED_SECRET":"updater"}\rmalicious${'x'.repeat(4_000)}`,
  );
  assert.doesNotMatch(
    sanitized,
    /two words|value|password@|abc\.def|session=|base64secret|mail|updater|\u001b|\r|\n/,
  );
  assert.ok(sanitized.length <= 2_000);
});
