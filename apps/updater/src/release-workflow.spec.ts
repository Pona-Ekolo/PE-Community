import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateManifest } from './domain.js';

test('release validator remains executable and is invoked through Bash', async () => {
  const [workflow, stage] = await Promise.all([
    readFile(
      new URL('../../../.github/workflows/publish-images.yml', import.meta.url),
      'utf8',
    ),
    Promise.resolve(
      execFileSync(
        'git',
        ['ls-files', '--stage', '.github/scripts/validate-release-ref.sh'],
        {
          cwd: new URL('../../..', import.meta.url),
          encoding: 'utf8',
        },
      ),
    ),
  ]);

  assert.match(stage, /^100755 /);
  assert.match(workflow, /bash \.github\/scripts\/validate-release-ref\.sh/);
});

test('release workflow is SHA-pinned, least-privilege, draft-first, and inventory-gated', async () => {
  const workflow = await readFile(
    new URL('../../../.github/workflows/publish-images.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /push:\s*\n\s*tags:/);
  assert.match(
    workflow,
    /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*release_tag:\s*\n\s*description: Existing published annotated release used for production provenance verification\s*\n\s*required: true\s*\n\s*type: string/,
  );
  assert.match(workflow, /mode=release/);
  assert.match(workflow, /mode=validation/);
  assert.match(workflow, /if \[\[ "\$RELEASE_TAG" == "v0\.0\.0" \]\]/);
  assert.match(workflow, /image_tag=validation-fixture-\$source_commit/);
  assert.match(workflow, /else\s+echo "image_tag=\$RELEASE_TAG"/);
  assert.doesNotMatch(workflow, /image_tag=(?:latest|stable)/);
  assert.match(workflow, /Manual validation must run from main/);
  assert.match(workflow, /build_version=v0\.0\.0-validation\.\$RUN_ID/);
  assert.match(workflow, /image_tag=validation-\$RUN_ID/);
  assert.match(workflow, /source_commit=\$DISPATCH_SHA/);
  assert.match(
    workflow,
    /PROVENANCE_TEST_RELEASE_TAG: \$\{\{ inputs\.release_tag \}\}/,
  );
  assert.match(
    workflow,
    /Historical provenance release tag must be strict stable semver/,
  );
  assert.match(
    workflow,
    /git fetch --force --no-tags origin "\$tag_ref:\$tag_ref"/,
  );
  assert.match(workflow, /Historical provenance release tag must be annotated/);
  assert.match(workflow, /provenance_test_release_tag=/);
  assert.match(workflow, /provenance_test_source_commit=/);
  assert.doesNotMatch(
    workflow,
    /Supply-chain validation must run from an existing annotated release tag/,
  );
  assert.match(workflow, /node \.github\/scripts\/publish-release-draft\.mjs/);
  assert.match(
    workflow,
    /SOURCE_COMMIT: \$\{\{ needs\.validate\.outputs\.source_commit \}\}/,
  );
  assert.match(workflow, /RELEASE_ARTIFACT_DIRECTORY: release-artifacts/);
  assert.match(workflow, /\.github\/scripts\/validate-release-ref\.sh/);
  assert.match(
    workflow,
    /RELEASE_REF="\$RELEASE_REF" RELEASE_REF_TYPE="\$REF_TYPE" CHECKOUT_SHA="\$DISPATCH_SHA" bash \.github\/scripts\/validate-release-ref\.sh/,
  );
  assert.doesNotMatch(
    workflow,
    /CHECKOUT_SHA="\$DISPATCH_SHA" \.github\/scripts\/validate-release-ref\.sh/,
  );
  assert.match(
    workflow,
    /RELEASE_REF="\$RELEASE_REF" RELEASE_REF_TYPE="\$REF_TYPE" CHECKOUT_SHA="\$DISPATCH_SHA"/,
  );
  assert.equal(
    (workflow.match(/actions\/attest-build-provenance@[a-f0-9]{40}/g) ?? [])
      .length,
    4,
  );
  const actionUses = [...workflow.matchAll(/uses:\s*[^\s@]+@([^\s#]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(actionUses.length > 0);
  assert.ok(actionUses.every((reference) => /^[a-f0-9]{40}$/.test(reference)));
  assert.match(
    workflow,
    /attestationPolicy:\\?"GITHUB_PROVENANCE_REQUIRED\\?"/,
  );
  assert.match(workflow, /releaseContractVersion:2/);
  assert.match(workflow, /releaseTag:\$version/);
  assert.match(workflow, /subject-path: pe-community-update-manifest\.json/);
  for (const asset of [
    'pe-community-update-manifest.attestation.jsonl',
    'pe-community-api.attestation.jsonl',
    'pe-community-web.attestation.jsonl',
    'pe-community-worker.attestation.jsonl',
  ]) {
    assert.match(workflow, new RegExp(asset.replaceAll('.', '\\.')));
  }
  assert.match(workflow, /needs: \[validate, image\]/);
  assert.match(workflow, /verifyPinnedArchive/);
  assert.match(workflow, /verifyUpstreamArchiveEntries/);
  assert.match(workflow, /verifyBundleEntries/);
  assert.match(workflow, /verify-bundled-provenance\.mjs/);
  assert.match(workflow, /verify-bundled-validation-provenance\.mjs/);
  assert.match(
    workflow,
    /Verify current validation and historical release provenance with the bundled CLI/,
  );
  assert.match(workflow, /Historical provenance release must be published/);
  assert.match(workflow, /Historical provenance release must be stable/);
  assert.match(workflow, /HISTORICAL_RELEASE_MANIFEST_MISSING/);
  assert.match(workflow, /HISTORICAL_RELEASE_MANIFEST_ATTESTATION_MISSING/);
  assert.match(workflow, /HISTORICAL_RELEASE_CONTRACT_UNSUPPORTED/);
  assert.match(workflow, /HISTORICAL_RELEASE_API_DIGEST_MISSING/);
  assert.match(workflow, /HISTORICAL_RELEASE_WEB_DIGEST_MISSING/);
  assert.match(workflow, /HISTORICAL_RELEASE_WORKER_DIGEST_MISSING/);
  assert.match(workflow, /refs\/tags\/\$PROVENANCE_TEST_RELEASE_TAG/);
  assert.match(
    workflow,
    /source_commit="\$\(git rev-parse "refs\/tags\/\$RELEASE_TAG\^\{commit\}"\)"/,
  );
  assert.match(workflow, /PROVENANCE_POLICY_REPOSITORY_MISMATCH_NOT_REJECTED/);
  const historicalProof = workflow.slice(
    workflow.indexOf('          release='),
    workflow.indexOf('      - name: Upload packaged validation artifacts'),
  );
  assert.match(historicalProof, /historical_asset_count\(\)/);
  assert.doesNotMatch(historicalProof, /expected_historical_assets/);
  assert.doesNotMatch(
    historicalProof,
    /pe-community-updater-\$\{PROVENANCE_TEST_RELEASE_TAG\}-linux-/,
  );
  assert.match(
    historicalProof,
    /attestation verify "\$historical_manifest" --bundle "\$historical_manifest_bundle"[\s\S]*> "\$stage\/historical-manifest-verification\.txt"/,
  );
  assert.match(historicalProof, /raw\.releaseContractVersion !== 2/);
  assert.match(
    historicalProof,
    /Historical \$\{PROVENANCE_TEST_RELEASE_TAG\} manifest provenance: verified/,
  );
  assert.match(workflow, /Current validation API provenance: verified/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /github-cli-MIT\.txt/);
  assert.match(
    workflow,
    /tar --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX'/,
  );
  assert.match(workflow, /GH_VERSION=2\.93\.0/);
  assert.match(workflow, /gh_\$\{GH_VERSION\}_linux_amd64\.tar\.gz/);
  assert.match(workflow, /gh_\$\{GH_VERSION\}_linux_arm64\.tar\.gz/);
  const packagingStep = workflow.slice(
    workflow.indexOf('      - name: Build final release artifacts'),
    workflow.indexOf('      - id: manifest-attestation'),
  );
  assert.match(packagingStep, /verify_bundled_gh\(\)/);
  assert.match(
    packagingStep,
    /linux-amd64\) expected_machine="Advanced Micro Devices X86-64"/,
  );
  assert.match(packagingStep, /linux-arm64\) expected_machine="AArch64"/);
  assert.match(packagingStep, /readelf -h "\$gh_binary"/);
  assert.match(packagingStep, /BUNDLED_GH_MISSING/);
  assert.match(packagingStep, /BUNDLED_GH_ARCHITECTURE_MISMATCH/);
  assert.match(packagingStep, /BUNDLED_GH_VERSION_MISMATCH/);
  assert.match(
    packagingStep,
    /if \[\[ "\$architecture" == "linux-amd64" \]\]; then\s*if ! version_line="\$\("\$gh_binary" version \| head -n1\)"/,
  );
  assert.doesNotMatch(
    packagingStep,
    /^\s*\[\[ "\$\("\$gh_binary" version \| head -n1\)" ==/m,
  );
  assert.match(
    packagingStep,
    /verify_bundled_gh "\$architecture" "\$gh_binary"/,
  );
  assert.doesNotMatch(workflow, /gh release (?:create|upload|edit)/);
  assert.match(
    workflow,
    /publish-release:\s*\n\s*if: github\.event_name == 'push'/,
  );
  assert.match(workflow, /if: needs\.validate\.outputs\.mode == 'validation'/);
  assert.match(
    workflow,
    /if: needs\.validate\.outputs\.mode == 'release'\s*\n\s*uses: actions\/attest-build-provenance/,
  );
  assert.match(workflow, /type:"supply-chain-validation"/);
  assert.match(workflow, /pe-community-validation-manifest\.json/);
  assert.doesNotMatch(workflow, /release:\s*\n\s*types:\s*\[published\]/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.doesNotMatch(workflow, /ghcr\.io\/[^\s]+:latest/);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  assert.doesNotMatch(workflow, /\/usr\/bin\/gh/);
  const imageJob = workflow.slice(
    workflow.indexOf('  image:'),
    workflow.indexOf('  artifacts:'),
  );
  assert.doesNotMatch(imageJob, /contents:\s*write/);
  const sharedValidationJobs = workflow.slice(
    workflow.indexOf('  image:'),
    workflow.indexOf('  publish-release:'),
  );
  assert.doesNotMatch(
    sharedValidationJobs,
    /gh release (?:create|upload|edit)/,
  );
  assert.equal((workflow.match(/contents:\s*write/g) ?? []).length, 1);
  assert.equal(
    (
      workflow.match(
        /APP_VERSION=\$\{\{ needs\.validate\.outputs\.version \}\}/g,
      ) ?? []
    ).length,
    3,
  );
  assert.equal(
    (
      workflow.match(
        /SOURCE_COMMIT=\$\{\{ needs\.validate\.outputs\.source_commit \}\}/g,
      ) ?? []
    ).length,
    3,
  );
  assert.equal(
    (
      workflow.match(
        /BUILD_DATE=\$\{\{ needs\.validate\.outputs\.build_date \}\}/g,
      ) ?? []
    ).length,
    3,
  );
  for (const dockerfilePath of [
    '../../api/Dockerfile',
    '../../web/Dockerfile',
    '../../worker/Dockerfile',
  ]) {
    const dockerfile = await readFile(
      new URL(dockerfilePath, import.meta.url),
      'utf8',
    );
    assert.match(
      dockerfile,
      /org\.opencontainers\.image\.version=\$\{APP_VERSION\}/,
    );
    assert.match(
      dockerfile,
      /org\.opencontainers\.image\.revision=\$\{SOURCE_COMMIT\}/,
    );
    assert.match(
      dockerfile,
      /org\.opencontainers\.image\.created=\$\{BUILD_DATE\}/,
    );
  }

  const runtimeProvenance = await readFile(
    new URL('./provenance.ts', import.meta.url),
    'utf8',
  );
  assert.match(runtimeProvenance, /`refs\/tags\/\$\{input\.releaseTag\}`/);
  assert.doesNotMatch(runtimeProvenance, /refs\/heads\/main/);

  const validationProvenance = await readFile(
    new URL(
      '../../../deploy/updater/verify-bundled-validation-provenance.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(validationProvenance, /refs\/heads\/main/);
  assert.match(
    validationProvenance,
    /Pona-Ekolo\/PE-Community\/\.github\/workflows\/publish-images\.yml/,
  );
  for (const verifierPath of [
    '../../../deploy/updater/verify-bundled-provenance.mjs',
    '../../../deploy/updater/verify-bundled-validation-provenance.mjs',
  ]) {
    const verifier = await readFile(
      new URL(verifierPath, import.meta.url),
      'utf8',
    );
    assert.match(verifier, /stdio: \['ignore', 'ignore', 'inherit'\]/);
    assert.doesNotMatch(verifier, /stdio: 'inherit'/);
  }
});

test('workflow-shaped manifest fixture satisfies release contract version two', () => {
  const version = 'v1.2.3';
  const manifest = validateManifest({
    schemaVersion: 2,
    releaseContractVersion: 2,
    version,
    releaseTag: version,
    channel: 'stable',
    minimumVersion: 'v0.1.0',
    minimumUpdaterVersion: 'v1.3.0',
    sourceCommit: 'd'.repeat(40),
    buildDate: '2026-08-31T00:00:00Z',
    images: {
      api: {
        repository: 'ghcr.io/pona-ekolo/pe-community-api',
        digest: `sha256:${'a'.repeat(64)}`,
      },
      web: {
        repository: 'ghcr.io/pona-ekolo/pe-community-web',
        digest: `sha256:${'b'.repeat(64)}`,
      },
      worker: {
        repository: 'ghcr.io/pona-ekolo/pe-community-worker',
        digest: `sha256:${'c'.repeat(64)}`,
      },
    },
    database: { migrationCompatibility: 'FORWARD_ONLY' },
    supplyChain: { attestationPolicy: 'GITHUB_PROVENANCE_REQUIRED' },
    requiresManualAction: false,
  });
  assert.equal(manifest.releaseContractVersion, 2);
});

test('unsupported future release contracts fail closed', () => {
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 2,
        releaseContractVersion: 3,
        version: 'v1.2.3',
        releaseTag: 'v1.2.3',
        channel: 'stable',
        minimumVersion: 'v0.1.0',
        minimumUpdaterVersion: 'v1.3.0',
        sourceCommit: 'd'.repeat(40),
        images: {
          api: {
            repository: 'ghcr.io/pona-ekolo/pe-community-api',
            digest: `sha256:${'a'.repeat(64)}`,
          },
          web: {
            repository: 'ghcr.io/pona-ekolo/pe-community-web',
            digest: `sha256:${'b'.repeat(64)}`,
          },
          worker: {
            repository: 'ghcr.io/pona-ekolo/pe-community-worker',
            digest: `sha256:${'c'.repeat(64)}`,
          },
        },
        database: { migrationCompatibility: 'FORWARD_ONLY' },
        supplyChain: { attestationPolicy: 'GITHUB_PROVENANCE_REQUIRED' },
        requiresManualAction: false,
      }),
    /RELEASE_CONTRACT_UNSUPPORTED/,
  );
});
