import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  CommandExecutor,
  CommandOptions,
  CommandResult,
} from './executor.js';
import {
  assertBundledVerifier,
  GitHubCliProvenanceVerifier,
  GitHubCliManifestAttestationVerifier,
  PROVENANCE_POLICY,
  ProvenanceError,
} from './provenance.js';
import { bundledVerifierPath, updaterInstallRoot } from './config.js';

const digest = `sha256:${'a'.repeat(64)}`;
const sourceCommit = 'd'.repeat(40);
const input = {
  service: 'api' as const,
  repository: 'ghcr.io/pona-ekolo/pe-community-api',
  digest,
  bundle: new TextEncoder().encode(
    '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
  ),
  releaseTag: 'v1.2.3',
  sourceCommit,
};

test('official verifier uses the bundled executable, exact digest, and immutable policy argv', async () => {
  const executor = new VerifierExecutor();
  const result = await provenanceVerifier(executor).verify(input);
  assert.equal(result.result, 'VERIFIED');
  assert.equal(result.digest, digest);
  assert.equal(executor.calls[0]?.executable, bundledVerifierPath());
  assert.deepEqual(executor.calls[0]?.args, ['version']);
  assert.equal(executor.calls[0]?.timeoutMs, 10_000);
  assert.equal(executor.calls[0]?.maxOutputBytes, 64 * 1024);
  assert.deepEqual(executor.calls[1]?.args, [
    'attestation',
    'verify',
    `oci://${input.repository}@${digest}`,
    '--bundle',
    executor.calls[1]?.args[4],
    '--repo',
    'Pona-Ekolo/PE-Community',
    '--hostname',
    'github.com',
    '--signer-workflow',
    'Pona-Ekolo/PE-Community/.github/workflows/publish-images.yml',
    '--predicate-type',
    'https://slsa.dev/provenance/v1',
    '--cert-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    '--source-ref',
    'refs/tags/v1.2.3',
    '--source-digest',
    sourceCommit,
    '--deny-self-hosted-runners',
    '--limit',
    '10',
    '--format',
    'json',
  ]);
  assert.equal(executor.calls[1]?.timeoutMs, PROVENANCE_POLICY.timeoutMs);
  assert.equal(
    executor.calls[1]?.maxOutputBytes,
    PROVENANCE_POLICY.maximumOutputBytes,
  );
  assert.deepEqual(Object.keys(executor.calls[1]?.env ?? {}).sort(), [
    'DOCKER_CONFIG',
    'GH_CONFIG_DIR',
    'HOME',
    'LANG',
    'LC_ALL',
    'NO_COLOR',
    'PATH',
  ]);
  assert.equal(executor.calls[1]?.env?.GH_TOKEN, undefined);
  assert.equal(executor.calls[1]?.env?.GITHUB_TOKEN, undefined);
  assert.equal(executor.calls[1]?.env?.GH_HOST, undefined);
  assert.equal(executor.calls[1]?.env?.GH_ENTERPRISE_TOKEN, undefined);
  assert.notEqual(executor.calls[1]?.env?.HOME, process.env.HOME);
  await assert.rejects(
    () => stat(String(executor.calls[1]?.args[4])),
    /ENOENT/,
  );
});

test('bundled verifier resolution follows the installed package instead of a fixed host path', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'pe-updater-relocation-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of ['updater/dist', 'nested/community-updater/dist']) {
    const packageRoot = join(root, relative.replace('/dist', ''));
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    const moduleUrl = new URL(
      `file://${join(packageRoot, 'dist', 'config.js')}`,
    ).href;
    assert.equal(updaterInstallRoot(moduleUrl), packageRoot);
    assert.equal(
      bundledVerifierPath(moduleUrl),
      join(packageRoot, 'bin', 'gh'),
    );
  }
});

test('verifier fails deterministically when missing, wrong-version, timed out, or output-bounded', async () => {
  await expectCode(
    provenanceVerifier(new VerifierExecutor(systemError('ENOENT'))).preflight(),
    'PROVENANCE_VERIFIER_MISSING',
  );
  await expectCode(
    provenanceVerifier(
      new VerifierExecutor(undefined, 'gh version 2.92.1\n'),
    ).preflight(),
    'PROVENANCE_VERIFIER_UNSUPPORTED',
  );
  await expectCode(
    provenanceVerifier(
      new VerifierExecutor({ killed: true, message: 'timed out' }),
    ).preflight(),
    'PROVENANCE_TIMEOUT',
  );
  await expectCode(
    provenanceVerifier(
      new VerifierExecutor(systemError('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')),
    ).preflight(),
    'PROVENANCE_OUTPUT_INVALID',
  );
});

test('verifier rejects missing attestations, network failures, invalid signatures, and non-zero failures', async () => {
  for (const [stderr, code] of [
    ['no attestations found', 'IMAGE_BUNDLE_MISSING_API'],
    ['network connection failed', 'TRUST_ROOT_UNAVAILABLE'],
    ['signature verification failed', 'IMAGE_PROVENANCE_INVALID_API'],
    ['unexpected gh failure', 'IMAGE_PROVENANCE_INVALID_API'],
  ] as const) {
    const executor = new VerifierExecutor();
    executor.verifyError = { message: 'command failed', stderr };
    await expectCode(provenanceVerifier(executor).verify(input), code);
  }
});

test('verifier output must cryptographically report the exact subject digest and trusted predicate', async () => {
  for (const [output, code] of [
    ['{invalid', 'IMAGE_PROVENANCE_INVALID_API'],
    ['[]', 'IMAGE_PROVENANCE_INVALID_API'],
    [
      JSON.stringify(verificationOutput(`sha256:${'b'.repeat(64)}`)),
      'IMAGE_DIGEST_MISMATCH_API',
    ],
    [
      JSON.stringify(
        verificationOutput(digest, 'https://example.invalid/predicate'),
      ),
      'IMAGE_PROVENANCE_INVALID_API',
    ],
    [
      JSON.stringify([
        {
          verificationResult: {
            statement:
              verificationOutput(digest)[0].verificationResult.statement,
          },
        },
      ]),
      'IMAGE_PROVENANCE_INVALID_API',
    ],
  ] as const) {
    const executor = new VerifierExecutor(undefined, undefined, output);
    await expectCode(provenanceVerifier(executor).verify(input), code);
  }
});

test('manifest values cannot inject argv or redefine repository, workflow, or executable trust', async () => {
  const verifier = provenanceVerifier(new VerifierExecutor());
  await expectCode(
    verifier.verify({ ...input, releaseTag: 'v1.2.3;id' }),
    'IMAGE_PROVENANCE_INVALID_API',
  );
  await expectCode(
    verifier.verify({ ...input, digest: `${digest};id` }),
    'IMAGE_DIGEST_MISMATCH_API',
  );
  await expectCode(
    verifier.verify({ ...input, repository: 'ghcr.io/attacker/image' }),
    'IMAGE_PROVENANCE_INVALID_API',
  );
  await expectCode(
    verifier.verify({
      ...input,
      service: 'web',
      repository: 'ghcr.io/pona-ekolo/pe-community-api',
    }),
    'IMAGE_PROVENANCE_INVALID_WEB',
  );
  await expectCode(
    verifier.verify({ ...input, sourceCommit: `${sourceCommit};id` }),
    'IMAGE_PROVENANCE_INVALID_API',
  );
});

test('manifest verifier authenticates exact bytes before parsing with immutable policy argv', async () => {
  const payload = new TextEncoder().encode('{"releaseContractVersion":2}');
  const executor = new VerifierExecutor(
    undefined,
    undefined,
    JSON.stringify(manifestVerificationOutput(payload)),
  );
  const result = await manifestVerifierWithInspector(executor).verify({
    payload,
    bundle: input.bundle,
    releaseTag: 'v1.2.3',
    sourceCommit,
  });
  assert.equal(result.service, 'manifest');
  assert.equal(
    result.digest,
    `sha256:${createHash('sha256').update(payload).digest('hex')}`,
  );
  const args = executor.calls[1]?.args ?? [];
  assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
  assert.match(
    String(args[2]),
    /\/pe-community-manifest-[^/]+\/pe-community-update-manifest\.json$/,
  );
  assert.equal(args[3], '--bundle');
  assert.match(
    String(args[4]),
    /pe-community-update-manifest\.attestation\.jsonl$/,
  );
  assert.deepEqual(args.slice(5), [
    '--repo',
    'Pona-Ekolo/PE-Community',
    '--hostname',
    'github.com',
    '--signer-workflow',
    'Pona-Ekolo/PE-Community/.github/workflows/publish-images.yml',
    '--predicate-type',
    'https://slsa.dev/provenance/v1',
    '--cert-oidc-issuer',
    'https://token.actions.githubusercontent.com',
    '--source-ref',
    'refs/tags/v1.2.3',
    '--source-digest',
    sourceCommit,
    '--deny-self-hosted-runners',
    '--limit',
    '10',
    '--format',
    'json',
  ]);
  await assert.rejects(() => stat(String(args[2])), /ENOENT/);
  await assert.rejects(() => stat(String(args[4])), /ENOENT/);
});

test('manifest verifier rejects missing, invalid, wrong-identity, wrong-workflow, source, timeout, and fetch failures', async () => {
  for (const [stderr, code] of [
    ['no attestations found', 'MANIFEST_BUNDLE_MISSING'],
    ['signature verification failed', 'MANIFEST_BUNDLE_INVALID'],
    ['repository identity mismatch', 'MANIFEST_SIGNER_MISMATCH'],
    ['signer workflow mismatch', 'MANIFEST_WORKFLOW_MISMATCH'],
    ['source digest mismatch', 'MANIFEST_SOURCE_MISMATCH'],
    ['network connection failed', 'TRUST_ROOT_UNAVAILABLE'],
  ] as const) {
    const executor = new VerifierExecutor();
    executor.verifyError = { message: 'command failed', stderr };
    await expectCode(
      manifestVerifierWithInspector(executor).verify({
        payload: new TextEncoder().encode('{}'),
        releaseTag: 'v1.2.3',
        sourceCommit,
      }),
      code,
    );
  }
  const timeout = new VerifierExecutor();
  timeout.verifyError = { killed: true, message: 'timed out' };
  await expectCode(
    manifestVerifierWithInspector(timeout).verify({
      payload: new TextEncoder().encode('{}'),
      releaseTag: 'v1.2.3',
      sourceCommit,
    }),
    'MANIFEST_BUNDLE_INVALID',
  );
  await expectCode(
    manifestVerifierWithInspector(
      new VerifierExecutor(systemError('ENOENT')),
    ).verify({
      payload: new TextEncoder().encode('{}'),
      releaseTag: 'v1.2.3',
      sourceCommit,
    }),
    'PROVENANCE_VERIFIER_MISSING',
  );
});

test('manifest tampering and malformed verifier output fail with no digest trust', async () => {
  const signed = new TextEncoder().encode('{"version":"v1.2.3"}');
  const tampered = new TextEncoder().encode('{"version":"v9.9.9"}');
  const executor = new VerifierExecutor(
    undefined,
    undefined,
    JSON.stringify(manifestVerificationOutput(signed)),
  );
  await expectCode(
    manifestVerifierWithInspector(executor).verify({
      payload: tampered,
      releaseTag: 'v1.2.3',
      sourceCommit,
    }),
    'MANIFEST_SUBJECT_MISMATCH',
  );
  await expectCode(
    manifestVerifierWithInspector(
      new VerifierExecutor(undefined, undefined, '{bad'),
    ).verify({
      payload: signed,
      releaseTag: 'v1.2.3',
      sourceCommit,
    }),
    'MANIFEST_BUNDLE_INVALID',
  );
});

class VerifierExecutor implements CommandExecutor {
  calls: Array<{
    executable: string;
    args: readonly string[];
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: NodeJS.ProcessEnv;
  }> = [];
  verifyError: unknown;

  constructor(
    private readonly versionError?: unknown,
    private readonly versionOutput = 'gh version 2.93.0 (2026-05-27)\n',
    private readonly verifyOutput = JSON.stringify(verificationOutput(digest)),
  ) {}

  async run(
    executable: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    this.calls.push({
      executable,
      args,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      env: options.env,
    });
    if (args[0] === 'version') {
      if (this.versionError) throw this.versionError;
      return { stdout: this.versionOutput, stderr: '' };
    }
    if (this.verifyError) throw this.verifyError;
    return { stdout: this.verifyOutput, stderr: '' };
  }

  async capture() {
    return { stderr: '' };
  }
}

function provenanceVerifier(executor: CommandExecutor) {
  return new GitHubCliProvenanceVerifier(executor, () => {});
}

function manifestVerifierWithInspector(executor: CommandExecutor) {
  const verifier = new GitHubCliManifestAttestationVerifier(executor, () => {});
  return {
    verify(
      input: Omit<Parameters<typeof verifier.verify>[0], 'bundle'> & {
        bundle?: Uint8Array;
      },
    ) {
      return verifier.verify({
        ...input,
        bundle: input.bundle ?? new Uint8Array([1]),
      });
    },
  };
}

test('bundled verifier inspection rejects a missing, symlinked, writable, or non-root verifier', () => {
  const valid = {
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100755,
    uid: 0,
  };
  assert.doesNotThrow(() =>
    assertBundledVerifier('/tmp/pe-community-updater/bin/gh', {
      lstat: () => valid,
      realpath: (path) => path,
    }),
  );
  assert.throws(
    () =>
      assertBundledVerifier('/tmp/pe-community-updater/bin/gh', {
        lstat: () => {
          throw systemError('ENOENT');
        },
        realpath: (path) => path,
      }),
    (error: unknown) =>
      error instanceof ProvenanceError &&
      error.code === 'PROVENANCE_VERIFIER_MISSING',
  );
  for (const stat of [
    { ...valid, isSymbolicLink: () => true },
    { ...valid, mode: 0o100775 },
    { ...valid, uid: 1000 },
  ]) {
    assert.throws(
      () =>
        assertBundledVerifier('/tmp/pe-community-updater/bin/gh', {
          lstat: () => stat,
          realpath: (path) => path,
        }),
      (error: unknown) =>
        error instanceof ProvenanceError &&
        error.code === 'PROVENANCE_VERIFIER_UNSAFE',
    );
  }
});

function verificationOutput(
  subjectDigest: string,
  predicateType: string = PROVENANCE_POLICY.predicateType,
) {
  return [
    {
      verificationResult: {
        statement: {
          predicateType,
          subject: [
            {
              name: input.repository,
              digest: { sha256: subjectDigest.slice('sha256:'.length) },
            },
          ],
        },
        signature: {
          certificate: { sourceRepository: PROVENANCE_POLICY.repository },
        },
        verifiedTimestamps: [
          { type: 'TLOG', timestamp: '2026-08-31T00:00:00Z' },
        ],
      },
    },
  ];
}

function manifestVerificationOutput(payload: Uint8Array) {
  return [
    {
      verificationResult: {
        statement: {
          predicateType: PROVENANCE_POLICY.predicateType,
          subject: [
            {
              name: 'pe-community-update-manifest.json',
              digest: {
                sha256: createHash('sha256').update(payload).digest('hex'),
              },
            },
          ],
        },
        signature: {
          certificate: { sourceRepository: PROVENANCE_POLICY.repository },
        },
        verifiedTimestamps: [
          { type: 'TLOG', timestamp: '2026-08-31T00:00:00Z' },
        ],
      },
    },
  ];
}

function systemError(code: string) {
  return Object.assign(new Error(code), { code });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ProvenanceError && error.code === code,
  );
}
