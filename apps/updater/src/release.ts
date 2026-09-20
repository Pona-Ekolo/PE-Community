import {
  compareVersions,
  isValidationFixtureVersion,
  parseVersion,
  validateManifest,
  type ReleaseManifest,
} from './domain.js';
import type {
  ManifestAttestationVerifier,
  ProvenanceVerificationResult,
} from './provenance.js';

const RELEASES_URL =
  'https://api.github.com/repos/Pona-Ekolo/PE-Community/releases/latest';
const GIT_API_PREFIX =
  'https://api.github.com/repos/Pona-Ekolo/PE-Community/git/';
const MANIFEST_NAME = 'pe-community-update-manifest.json';
const MANIFEST_ATTESTATION_NAME =
  'pe-community-update-manifest.attestation.jsonl';
const IMAGE_ATTESTATION_NAMES = Object.freeze({
  api: 'pe-community-api.attestation.jsonl',
  web: 'pe-community-web.attestation.jsonl',
  worker: 'pe-community-worker.attestation.jsonl',
} as const);
const MAX_RELEASE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ATTESTATION_BUNDLE_BYTES = 4 * 1024 * 1024;
const MANIFEST_REDIRECT_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const UPDATER_ARCHITECTURES = ['linux-amd64', 'linux-arm64'] as const;

export type AgentRelease = {
  version: string;
  releaseUrl: string;
  publishedAt: string;
  notes: string;
  manifest: ReleaseManifest;
  manifestProvenance: ProvenanceVerificationResult;
  imageBundles: Record<'api' | 'web' | 'worker', Uint8Array>;
};

export interface ReleaseProvider {
  latest(): Promise<AgentRelease>;
  target(version: string): Promise<AgentRelease>;
}

export class GitHubReleaseProvider implements ReleaseProvider {
  constructor(
    private readonly request: typeof fetch,
    private readonly manifestVerifier: ManifestAttestationVerifier,
  ) {}

  async latest() {
    return this.load(RELEASES_URL, false, null);
  }

  async target(version: string) {
    const target = parseVersion(version).normalized;
    return this.load(
      `https://api.github.com/repos/Pona-Ekolo/PE-Community/releases/tags/${encodeURIComponent(target)}`,
      true,
      target,
    );
  }

  private async load(
    url: string,
    allowValidationFixture: boolean,
    expectedVersion: string | null,
  ): Promise<AgentRelease> {
    let response: Response;
    try {
      response = await this.request(url, {
        redirect: 'error',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'pe-community-updater',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new Error('RELEASE_DISCOVERY_FAILED', { cause });
    }
    if (!response.ok)
      throw new Error('RELEASE_DISCOVERY_FAILED', {
        cause: new Error(`GitHub release API returned HTTP ${response.status}`),
      });
    const release = await boundedJson(response, MAX_RELEASE_BYTES);
    if (!isObject(release)) throw new Error('RELEASE_INVALID');
    if (release.draft === true || release.prerelease === true)
      throw new Error('RELEASE_NOT_STABLE');
    const version = parseVersion(release.tag_name).normalized;
    if (expectedVersion && version !== expectedVersion)
      throw new Error('RELEASE_TAG_MISMATCH');
    if (!allowValidationFixture && isValidationFixtureVersion(version))
      throw new Error('VALIDATION_FIXTURE_NOT_INSTALLABLE');
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const requiredAssetNames = new Set([
      MANIFEST_NAME,
      MANIFEST_ATTESTATION_NAME,
      ...Object.values(IMAGE_ATTESTATION_NAMES),
      ...UPDATER_ARCHITECTURES.map(
        (architecture) =>
          `pe-community-updater-${version}-${architecture}.tar.gz`,
      ),
    ]);
    const assetNames = assets.map((asset) =>
      isObject(asset) ? asset.name : null,
    );
    if (
      assetNames.includes('pe-community-update-manifest.attestation.json') &&
      !assetNames.includes(MANIFEST_ATTESTATION_NAME)
    )
      throw new Error('LEGACY_RELEASE_MANUAL_REQUIRED');
    if (!assetNames.includes(MANIFEST_NAME))
      throw new Error('RELEASE_MANIFEST_MISSING');
    const missingBundle = Object.entries(IMAGE_ATTESTATION_NAMES).find(
      ([, name]) => !assetNames.includes(name),
    );
    if (!assetNames.includes(MANIFEST_ATTESTATION_NAME))
      throw new Error('MANIFEST_BUNDLE_MISSING');
    if (missingBundle)
      throw new Error(`IMAGE_BUNDLE_MISSING_${missingBundle[0].toUpperCase()}`);
    if (
      assetNames.length !== requiredAssetNames.size ||
      assetNames.some(
        (name) => typeof name !== 'string' || !requiredAssetNames.has(name),
      ) ||
      new Set(assetNames).size !== requiredAssetNames.size
    )
      throw new Error('RELEASE_ASSET_INVENTORY_INVALID');
    const byName = new Map<string, Record<string, unknown>>();
    for (const asset of assets) {
      if (!isObject(asset) || typeof asset.name !== 'string')
        throw new Error('RELEASE_ASSET_INVENTORY_INVALID');
      byName.set(asset.name, asset);
    }
    const manifestAsset = requiredAsset(
      byName,
      MANIFEST_NAME,
      'RELEASE_MANIFEST_MISSING',
    );
    const manifestBundleAsset = requiredAsset(
      byName,
      MANIFEST_ATTESTATION_NAME,
      'MANIFEST_BUNDLE_MISSING',
    );
    const manifestResponse = await fetchReleaseAsset(
      this.request,
      assetDownloadUrl(manifestAsset, version, MANIFEST_NAME),
    );
    if (!manifestResponse.ok) throw new Error('RELEASE_MANIFEST_UNAVAILABLE');
    const manifestPayload = await boundedBytes(
      manifestResponse,
      MAX_MANIFEST_BYTES,
      'MANIFEST_TOO_LARGE',
    );
    const manifestBundleResponse = await fetchReleaseAsset(
      this.request,
      assetDownloadUrl(manifestBundleAsset, version, MANIFEST_ATTESTATION_NAME),
    );
    if (!manifestBundleResponse.ok) throw new Error('MANIFEST_BUNDLE_MISSING');
    const manifestBundle = await boundedBytes(
      manifestBundleResponse,
      MAX_ATTESTATION_BUNDLE_BYTES,
      'MANIFEST_BUNDLE_INVALID',
    );
    const taggedCommit = await this.resolveAnnotatedTagCommit(version);
    const manifestProvenance = await this.manifestVerifier.verify({
      payload: manifestPayload,
      bundle: manifestBundle,
      releaseTag: version,
      sourceCommit: taggedCommit,
    });
    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(
        new TextDecoder().decode(manifestPayload),
      ) as unknown;
    } catch {
      throw new Error('MANIFEST_SCHEMA_INVALID');
    }
    let manifest: ReleaseManifest;
    try {
      manifest = validateManifest(manifestValue);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'RELEASE_CONTRACT_UNSUPPORTED'
      )
        throw error;
      throw new Error('MANIFEST_SCHEMA_INVALID');
    }
    if (compareVersions(manifest.version, version) !== 0)
      throw new Error('RELEASE_MANIFEST_VERSION_MISMATCH');
    if (manifest.releaseTag !== version)
      throw new Error('PROVENANCE_RELEASE_TAG_MISMATCH');
    if (taggedCommit !== manifest.sourceCommit)
      throw new Error('MANIFEST_SOURCE_MISMATCH');
    const imageBundles = {} as Record<'api' | 'web' | 'worker', Uint8Array>;
    for (const service of ['api', 'web', 'worker'] as const) {
      const name = IMAGE_ATTESTATION_NAMES[service];
      const response = await fetchReleaseAsset(
        this.request,
        assetDownloadUrl(
          requiredAsset(
            byName,
            name,
            `IMAGE_BUNDLE_MISSING_${service.toUpperCase()}`,
          ),
          version,
          name,
        ),
      );
      if (!response.ok)
        throw new Error(`IMAGE_BUNDLE_MISSING_${service.toUpperCase()}`);
      imageBundles[service] = await boundedBytes(
        response,
        MAX_ATTESTATION_BUNDLE_BYTES,
        `IMAGE_PROVENANCE_INVALID_${service.toUpperCase()}`,
      );
    }
    return {
      version,
      releaseUrl:
        typeof release.html_url === 'string'
          ? release.html_url
          : 'https://github.com/Pona-Ekolo/PE-Community/releases',
      publishedAt:
        typeof release.published_at === 'string' ? release.published_at : '',
      notes:
        typeof release.body === 'string' ? release.body.slice(0, 20_000) : '',
      manifest,
      manifestProvenance,
      imageBundles,
    };
  }

  private async resolveAnnotatedTagCommit(tag: string) {
    const reference = await this.githubJson(
      `${GIT_API_PREFIX}ref/tags/${encodeURIComponent(tag)}`,
    );
    const tagObject = isObject(reference.object) ? reference.object : null;
    if (
      !tagObject ||
      tagObject.type !== 'tag' ||
      typeof tagObject.sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(tagObject.sha)
    )
      throw new Error('RELEASE_TAG_NOT_ANNOTATED');
    const annotatedTag = await this.githubJson(
      `${GIT_API_PREFIX}tags/${tagObject.sha}`,
    );
    const target = isObject(annotatedTag.object) ? annotatedTag.object : null;
    if (
      !target ||
      target.type !== 'commit' ||
      typeof target.sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(target.sha)
    )
      throw new Error('RELEASE_TAG_TARGET_INVALID');
    return target.sha;
  }

  private async githubJson(url: string) {
    const response = await this.request(url, {
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'pe-community-updater',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`RELEASE_SOURCE_LOOKUP_FAILED_${response.status}`);
    const value = await boundedJson(response, MAX_RELEASE_BYTES);
    if (!isObject(value)) throw new Error('RELEASE_SOURCE_INVALID');
    return value;
  }
}

async function fetchReleaseAsset(request: typeof fetch, initialUrl: string) {
  let url = initialUrl;
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      !MANIFEST_REDIRECT_HOSTS.has(parsed.hostname) ||
      parsed.username ||
      parsed.password
    )
      throw new Error('RELEASE_ASSET_REDIRECT_INVALID');
    const response = await request(url, {
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        'user-agent': 'pe-community-updater',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirect === 3)
      throw new Error('RELEASE_ASSET_REDIRECT_INVALID');
    url = new URL(location, url).toString();
  }
  throw new Error('RELEASE_ASSET_REDIRECT_INVALID');
}

function requiredAsset(
  assets: Map<string, Record<string, unknown>>,
  name: string,
  missingCode: string,
) {
  const asset = assets.get(name);
  if (!asset) throw new Error(missingCode);
  return asset;
}

function assetDownloadUrl(
  asset: Record<string, unknown>,
  version: string,
  name: string,
) {
  if (typeof asset.browser_download_url !== 'string')
    throw new Error('RELEASE_ASSET_URL_INVALID');
  let parsed: URL;
  try {
    parsed = new URL(asset.browser_download_url);
  } catch {
    throw new Error('RELEASE_ASSET_URL_INVALID');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !==
      `/Pona-Ekolo/PE-Community/releases/download/${version}/${name}`
  )
    throw new Error(
      name === MANIFEST_NAME
        ? 'RELEASE_MANIFEST_URL_INVALID'
        : 'RELEASE_ASSET_URL_INVALID',
    );
  return parsed.toString();
}

async function boundedJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  return JSON.parse(
    new TextDecoder().decode(
      await boundedBytes(response, maximumBytes, 'RESPONSE_TOO_LARGE'),
    ),
  ) as unknown;
}

async function boundedBytes(
  response: Response,
  maximumBytes: number,
  tooLargeCode: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maximumBytes) throw new Error(tooLargeCode);
  if (!response.body) {
    const payload = new TextEncoder().encode(await response.text());
    if (payload.byteLength > maximumBytes) throw new Error(tooLargeCode);
    return payload;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error(tooLargeCode);
    }
    chunks.push(value);
  }
  const payload = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
