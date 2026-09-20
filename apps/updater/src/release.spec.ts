import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ALLOWED_IMAGE_REPOSITORIES } from './domain.js';
import type { ManifestAttestationVerifier } from './provenance.js';
import { GitHubReleaseProvider } from './release.js';

const manifest = {
  schemaVersion: 2,
  releaseContractVersion: 2,
  version: 'v1.2.3',
  releaseTag: 'v1.2.3',
  sourceCommit: 'd'.repeat(40),
  channel: 'stable',
  minimumVersion: 'v1.0.0',
  minimumUpdaterVersion: 'v1.1.0',
  images: Object.fromEntries(
    Object.entries(ALLOWED_IMAGE_REPOSITORIES).map(
      ([service, repository], index) => [
        service,
        { repository, digest: `sha256:${['a', 'b', 'c'][index].repeat(64)}` },
      ],
    ),
  ),
  database: { migrationCompatibility: 'FORWARD_ONLY' },
  supplyChain: { attestationPolicy: 'DIGEST_ONLY' },
  requiresManualAction: false,
};

test('release provider accepts one bounded manifest from the fixed release source', async () => {
  const request = async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes('/git/ref/tags/'))
      return jsonResponse({ object: { type: 'tag', sha: 'e'.repeat(40) } });
    if (value.includes('/git/tags/'))
      return jsonResponse({
        object: { type: 'commit', sha: manifest.sourceCommit },
      });
    if (value.includes('/releases/tags/')) {
      return jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets(),
      });
    }
    return jsonResponse(manifest);
  };
  const release = await releaseProvider(request as typeof fetch).target(
    'v1.2.3',
  );
  assert.equal(release.manifest.version, 'v1.2.3');
});

test('manifest attestation is verified before schema fields are trusted', async () => {
  let verifierCalls = 0;
  const rejectingVerifier: ManifestAttestationVerifier = {
    async verify() {
      verifierCalls += 1;
      throw new Error('MANIFEST_ATTESTATION_INVALID');
    },
  };
  const request = async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes('/releases/tags/'))
      return jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets(),
      });
    if (value.includes('/git/ref/tags/'))
      return jsonResponse({ object: { type: 'tag', sha: 'e'.repeat(40) } });
    if (value.includes('/git/tags/'))
      return jsonResponse({
        object: { type: 'commit', sha: manifest.sourceCommit },
      });
    return new Response('{not valid json', { status: 200 });
  };
  await assert.rejects(
    () =>
      new GitHubReleaseProvider(
        request as typeof fetch,
        rejectingVerifier,
      ).target('v1.2.3'),
    /MANIFEST_ATTESTATION_INVALID/,
  );
  assert.equal(verifierCalls, 1);
});

test('draft and prerelease releases are rejected before manifest verification', async () => {
  for (const flags of [
    { draft: true, prerelease: false },
    { draft: false, prerelease: true },
  ]) {
    let verifierCalls = 0;
    const verifier: ManifestAttestationVerifier = {
      async verify() {
        verifierCalls += 1;
        return manifestVerifier.verify({
          payload: new Uint8Array(),
          bundle: new Uint8Array([1]),
          releaseTag: 'v1.2.3',
          sourceCommit: manifest.sourceCommit,
        });
      },
    };
    await assert.rejects(
      () =>
        new GitHubReleaseProvider(
          (async () =>
            jsonResponse({
              tag_name: 'v1.2.3',
              assets: [],
              ...flags,
            })) as typeof fetch,
          verifier,
        ).target('v1.2.3'),
      /RELEASE_NOT_STABLE/,
    );
    assert.equal(verifierCalls, 0);
  }
});

test('release provider rejects duplicate assets and non-GitHub manifest URLs', async () => {
  const release = {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    assets: releaseAssets('https://evil.invalid/manifest.json'),
  };
  await assert.rejects(
    () =>
      releaseProvider((async () =>
        jsonResponse(release)) as typeof fetch).target('v1.2.3'),
    /RELEASE_MANIFEST_URL_INVALID/,
  );
  await assert.rejects(
    () =>
      releaseProvider((async () =>
        jsonResponse({
          ...release,
          assets: [...release.assets, release.assets[0]],
        })) as typeof fetch).target('v1.2.3'),
    /RELEASE_ASSET_INVENTORY_INVALID/,
  );
  await assert.rejects(
    () =>
      releaseProvider((async () =>
        jsonResponse({
          ...release,
          assets: release.assets.filter(
            (asset) =>
              asset.name !== 'pe-community-updater-v1.2.3-linux-arm64.tar.gz',
          ),
        })) as typeof fetch).target('v1.2.3'),
    /RELEASE_ASSET_INVENTORY_INVALID/,
  );
});

test('manifest redirects fail closed outside the allowlist', async () => {
  const request = async (url: string | URL | Request) => {
    if (String(url).includes('/releases/tags/')) {
      return jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets(),
      });
    }
    return new Response(null, {
      status: 302,
      headers: { location: 'https://evil.invalid/manifest.json' },
    });
  };
  await assert.rejects(
    () => releaseProvider(request as typeof fetch).target('v1.2.3'),
    /RELEASE_ASSET_REDIRECT_INVALID/,
  );
});

test('release discovery fails closed for transport, JSON, version, and schema failures', async () => {
  await assert.rejects(
    () =>
      releaseProvider((async () => {
        throw new Error('network unavailable');
      }) as typeof fetch).latest(),
    /RELEASE_DISCOVERY_FAILED/,
  );
  await assert.rejects(
    () =>
      releaseProvider(
        (async () => new Response('{invalid', { status: 200 })) as typeof fetch,
      ).latest(),
    /JSON/,
  );
  await assert.rejects(
    () =>
      releaseProvider((async () =>
        jsonResponse({
          tag_name: 'latest',
          draft: false,
          prerelease: false,
          assets: [],
        })) as typeof fetch).latest(),
    /INVALID_VERSION/,
  );
  const request = async (url: string | URL | Request) => {
    if (String(url).includes('/git/ref/tags/'))
      return jsonResponse({ object: { type: 'tag', sha: 'e'.repeat(40) } });
    if (String(url).includes('/git/tags/'))
      return jsonResponse({
        object: { type: 'commit', sha: manifest.sourceCommit },
      });
    if (String(url).startsWith('https://api.github.com/')) {
      return jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets(),
      });
    }
    return jsonResponse({ ...manifest, schemaVersion: 999 });
  };
  await assert.rejects(
    () => releaseProvider(request as typeof fetch).latest(),
    /MANIFEST_SCHEMA_INVALID/,
  );
});

test('release evidence inventory requires one manifest and all four JSONL bundles', async () => {
  const cases = [
    ['pe-community-update-manifest.json', 'RELEASE_MANIFEST_MISSING'],
    [
      'pe-community-update-manifest.attestation.jsonl',
      'MANIFEST_BUNDLE_MISSING',
    ],
    ['pe-community-api.attestation.jsonl', 'IMAGE_BUNDLE_MISSING_API'],
    ['pe-community-web.attestation.jsonl', 'IMAGE_BUNDLE_MISSING_WEB'],
    ['pe-community-worker.attestation.jsonl', 'IMAGE_BUNDLE_MISSING_WORKER'],
  ] as const;
  for (const [missing, code] of cases) {
    const request = (async () =>
      jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets().filter(({ name }) => name !== missing),
      })) as typeof fetch;
    await assert.rejects(
      () => releaseProvider(request).target('v1.2.3'),
      new RegExp(code),
    );
  }
});

test('legacy four-asset releases remain manual-only', async () => {
  const assets = releaseAssets()
    .filter(({ name }) => !name.endsWith('.attestation.jsonl'))
    .concat({
      name: 'pe-community-update-manifest.attestation.json',
      browser_download_url:
        'https://github.com/Pona-Ekolo/PE-Community/releases/download/v1.2.3/pe-community-update-manifest.attestation.json',
    });
  const request = (async () =>
    jsonResponse({
      tag_name: 'v1.2.3',
      draft: false,
      prerelease: false,
      assets,
    })) as typeof fetch;
  await assert.rejects(
    () => releaseProvider(request).target('v1.2.3'),
    /LEGACY_RELEASE_MANUAL_REQUIRED/,
  );
});

test('targeted verification accepts a valid permanent v0.0.0 fixture', async () => {
  const release = await releaseProvider(
    validationFixtureRequest() as typeof fetch,
  ).target('v0.0.0');
  assert.equal(release.version, 'v0.0.0');
  assert.equal(release.manifest.releaseTag, 'v0.0.0');
  assert.equal(release.manifest.releaseContractVersion, 2);
});

test('normal latest discovery rejects the permanent validation fixture', async () => {
  await assert.rejects(
    () => releaseProvider(validationFixtureRequest() as typeof fetch).latest(),
    /VALIDATION_FIXTURE_NOT_INSTALLABLE/,
  );
});

test('v0.0.0 remains fail-closed for legacy, malformed, unstable, and mismatched releases', async () => {
  const legacyAssets = validationFixtureAssets()
    .filter(({ name }) => !name.endsWith('.attestation.jsonl'))
    .concat({
      name: 'pe-community-update-manifest.attestation.json',
      browser_download_url:
        'https://github.com/Pona-Ekolo/PE-Community/releases/download/v0.0.0/pe-community-update-manifest.attestation.json',
    });
  for (const [options, code] of [
    [{ assets: legacyAssets }, 'LEGACY_RELEASE_MANUAL_REQUIRED'],
    [{ releaseTag: 'v0.0.0-rc.1' }, 'INVALID_VERSION'],
    [{ draft: true }, 'RELEASE_NOT_STABLE'],
    [{ prerelease: true }, 'RELEASE_NOT_STABLE'],
    [
      {
        assets: validationFixtureAssets().filter(
          ({ name }) => name !== 'pe-community-web.attestation.jsonl',
        ),
      },
      'IMAGE_BUNDLE_MISSING_WEB',
    ],
    [{ releaseTag: 'v0.0.1' }, 'RELEASE_TAG_MISMATCH'],
    [{ tagTarget: 'f'.repeat(40) }, 'MANIFEST_SOURCE_MISMATCH'],
  ] as const) {
    await assert.rejects(
      () =>
        releaseProvider(
          validationFixtureRequest(options) as typeof fetch,
        ).target('v0.0.0'),
      new RegExp(code),
    );
  }
});

test('release provider requires an annotated tag bound to manifest source commit', async () => {
  const request = async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes('/releases/tags/'))
      return jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets(),
      });
    if (value.includes('/git/ref/tags/'))
      return jsonResponse({ object: { type: 'tag', sha: 'e'.repeat(40) } });
    if (value.includes('/git/tags/'))
      return jsonResponse({ object: { type: 'commit', sha: 'f'.repeat(40) } });
    return jsonResponse(manifest);
  };
  await assert.rejects(
    () => releaseProvider(request as typeof fetch).target('v1.2.3'),
    /MANIFEST_SOURCE_MISMATCH/,
  );

  const lightweight = async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes('/releases/tags/'))
      return jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets(),
      });
    if (value.includes('/git/ref/tags/'))
      return jsonResponse({
        object: { type: 'commit', sha: manifest.sourceCommit },
      });
    return jsonResponse(manifest);
  };
  await assert.rejects(
    () => releaseProvider(lightweight as typeof fetch).target('v1.2.3'),
    /RELEASE_TAG_NOT_ANNOTATED/,
  );
});

test('release and manifest response bodies are bounded', async () => {
  await assert.rejects(
    () =>
      releaseProvider(
        (async () =>
          new Response('x', {
            status: 200,
            headers: { 'content-length': String(1024 * 1024 + 1) },
          })) as typeof fetch,
      ).latest(),
    /RESPONSE_TOO_LARGE/,
  );

  const request = async (url: string | URL | Request) => {
    if (String(url).includes('/releases/tags/'))
      return jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets(),
      });
    return new Response('x', {
      status: 200,
      headers: { 'content-length': String(128 * 1024 + 1) },
    });
  };
  await assert.rejects(
    () => releaseProvider(request as typeof fetch).target('v1.2.3'),
    /MANIFEST_TOO_LARGE/,
  );

  const oversizedBundle = async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes('/releases/tags/'))
      return jsonResponse({
        tag_name: 'v1.2.3',
        draft: false,
        prerelease: false,
        assets: releaseAssets(),
      });
    if (value.endsWith('/pe-community-update-manifest.json'))
      return jsonResponse(manifest);
    return new Response('x', {
      status: 200,
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    });
  };
  await assert.rejects(
    () => releaseProvider(oversizedBundle as typeof fetch).target('v1.2.3'),
    /MANIFEST_BUNDLE_INVALID/,
  );
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function releaseAssets(
  manifestUrl = 'https://github.com/Pona-Ekolo/PE-Community/releases/download/v1.2.3/pe-community-update-manifest.json',
) {
  return [
    {
      name: 'pe-community-update-manifest.json',
      browser_download_url: manifestUrl,
    },
    {
      name: 'pe-community-update-manifest.attestation.jsonl',
      browser_download_url:
        'https://github.com/Pona-Ekolo/PE-Community/releases/download/v1.2.3/pe-community-update-manifest.attestation.jsonl',
    },
    ...(['api', 'web', 'worker'] as const).map((service) => ({
      name: `pe-community-${service}.attestation.jsonl`,
      browser_download_url: `https://github.com/Pona-Ekolo/PE-Community/releases/download/v1.2.3/pe-community-${service}.attestation.jsonl`,
    })),
    {
      name: 'pe-community-updater-v1.2.3-linux-amd64.tar.gz',
      browser_download_url:
        'https://github.com/Pona-Ekolo/PE-Community/releases/download/v1.2.3/pe-community-updater-v1.2.3-linux-amd64.tar.gz',
    },
    {
      name: 'pe-community-updater-v1.2.3-linux-arm64.tar.gz',
      browser_download_url:
        'https://github.com/Pona-Ekolo/PE-Community/releases/download/v1.2.3/pe-community-updater-v1.2.3-linux-arm64.tar.gz',
    },
  ];
}

function validationFixtureManifest() {
  return {
    ...manifest,
    version: 'v0.0.0',
    releaseTag: 'v0.0.0',
    supplyChain: { attestationPolicy: 'GITHUB_PROVENANCE_REQUIRED' },
  };
}

function validationFixtureAssets() {
  return releaseAssets().map((asset) => ({
    ...asset,
    name: asset.name.replaceAll('v1.2.3', 'v0.0.0'),
    browser_download_url: asset.browser_download_url.replaceAll(
      'v1.2.3',
      'v0.0.0',
    ),
  }));
}

function validationFixtureRequest(
  options: {
    assets?: ReturnType<typeof validationFixtureAssets>;
    draft?: boolean;
    prerelease?: boolean;
    releaseTag?: string;
    tagTarget?: string;
  } = {},
) {
  const fixture = validationFixtureManifest();
  return async (url: string | URL | Request) => {
    const value = String(url);
    if (value.includes('/releases/tags/') || value.endsWith('/releases/latest'))
      return jsonResponse({
        tag_name: options.releaseTag ?? 'v0.0.0',
        draft: options.draft ?? false,
        prerelease: options.prerelease ?? false,
        assets: options.assets ?? validationFixtureAssets(),
      });
    if (value.includes('/git/ref/tags/'))
      return jsonResponse({ object: { type: 'tag', sha: 'e'.repeat(40) } });
    if (value.includes('/git/tags/'))
      return jsonResponse({
        object: {
          type: 'commit',
          sha: options.tagTarget ?? fixture.sourceCommit,
        },
      });
    if (value.endsWith('/pe-community-update-manifest.json'))
      return jsonResponse(fixture);
    return new Response('{}', { status: 200 });
  };
}

const manifestVerifier: ManifestAttestationVerifier = {
  async verify(input) {
    return {
      service: 'manifest',
      digest: `sha256:${createHash('sha256').update(input.payload).digest('hex')}`,
      policy: 'GITHUB_PROVENANCE_REQUIRED',
      verifiedAt: new Date(0).toISOString(),
      verifierVersion: '2.93.0',
      repository: 'Pona-Ekolo/PE-Community',
      workflow: '.github/workflows/publish-images.yml',
      result: 'VERIFIED',
    };
  },
};

function releaseProvider(
  request: typeof fetch,
  verifier: ManifestAttestationVerifier = manifestVerifier,
) {
  return new GitHubReleaseProvider(request, verifier);
}
