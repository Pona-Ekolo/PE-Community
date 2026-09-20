import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const EXPECTED_REPOSITORY = 'Pona-Ekolo/PE-Community';
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const VALIDATION_FIXTURE_TAG = 'v0.0.0';
const PRODUCTION_RELEASE_POLICY = Object.freeze({
  repository: EXPECTED_REPOSITORY,
  tagPattern: SEMVER_TAG,
});
export const READ_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
export const RELEASE_STATES = Object.freeze({
  NO_RELEASE: 'NO_RELEASE',
  DRAFT_CREATED: 'DRAFT_CREATED',
  DRAFT_PARTIAL: 'DRAFT_PARTIAL',
  DRAFT_COMPLETE: 'DRAFT_COMPLETE',
  PUBLISHED: 'PUBLISHED',
  AMBIGUOUS: 'AMBIGUOUS',
  INVALID: 'INVALID',
});

function fail(code) {
  throw new Error(code);
}

function assertReleaseIdentity(release, input, expectedDraft) {
  if (!release || !Number.isSafeInteger(release.id) || release.id <= 0)
    fail('RELEASE_ID_INVALID');
  if (release.tag_name !== input.tag) fail('RELEASE_TAG_MISMATCH');
  if (release.name !== input.tag) fail('RELEASE_NAME_MISMATCH');
  if (release.target_commitish !== input.sourceCommit)
    fail('RELEASE_TARGET_MISMATCH');
  if (release.prerelease !== false) fail('RELEASE_PRERELEASE_INVALID');
  if (release.draft !== expectedDraft)
    fail(expectedDraft ? 'RELEASE_NOT_DRAFT' : 'RELEASE_NOT_PUBLISHED');
}

function validateAssetInventory(
  release,
  artifacts,
  requireComplete,
  allowMissingDigest = false,
) {
  const expected = new Map(
    artifacts.map((artifact) => [artifact.name, artifact]),
  );
  const seen = new Set();

  for (const asset of release.assets ?? []) {
    if (seen.has(asset.name)) fail('RELEASE_ASSET_DUPLICATE');
    seen.add(asset.name);
    const artifact = expected.get(asset.name);
    if (!artifact) fail('RELEASE_ASSET_UNEXPECTED');
    if (asset.size !== artifact.size) fail('RELEASE_ASSET_SIZE_MISMATCH');
    if (!asset.digest && allowMissingDigest) continue;
    if (!asset.digest) fail('RELEASE_ASSET_DIGEST_MISSING');
    if (asset.digest !== artifact.digest) fail('RELEASE_ASSET_DIGEST_MISMATCH');
  }

  if (requireComplete && seen.size !== expected.size)
    fail('RELEASE_ASSET_INVENTORY_INCOMPLETE');
  return seen;
}

function isRetryableReadError(error) {
  return error instanceof Error && error.message === 'GITHUB_API_HTTP_404';
}

async function readReleaseWithRetry(
  api,
  releaseId,
  input,
  expectedDraft,
  completeInventory = false,
  requiredAssetName = null,
) {
  let lastError;
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const release = await api.getRelease(releaseId);
      assertReleaseIdentity(release, input, expectedDraft);
      if (completeInventory || requiredAssetName) {
        validateAssetInventory(release, input.artifacts, false, true);
        const names = new Set((release.assets ?? []).map(({ name }) => name));
        if (requiredAssetName && !names.has(requiredAssetName))
          fail('RELEASE_ASSET_INVENTORY_INCOMPLETE');
        if (completeInventory && names.size !== input.artifacts.length)
          fail('RELEASE_ASSET_INVENTORY_INCOMPLETE');
        if (completeInventory)
          validateAssetInventory(release, input.artifacts, true);
        else validateAssetInventory(release, input.artifacts, false);
      }
      return release;
    } catch (error) {
      const retryable =
        isRetryableReadError(error) ||
        ((completeInventory || requiredAssetName) &&
          error instanceof Error &&
          [
            'RELEASE_ASSET_INVENTORY_INCOMPLETE',
            'RELEASE_ASSET_DIGEST_MISSING',
          ].includes(error.message)) ||
        (!expectedDraft &&
          error instanceof Error &&
          error.message === 'RELEASE_NOT_PUBLISHED');
      if (!retryable) throw error;
      lastError = error;
      if (attempt < READ_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, READ_RETRY_DELAYS_MS[attempt]),
        );
      }
    }
  }
  throw new Error(
    completeInventory
      ? 'RELEASE_ASSET_VERIFICATION_TIMEOUT'
      : 'RELEASE_CREATE_READ_TIMEOUT',
    { cause: lastError },
  );
}

function selectRelease(releases, input) {
  const candidates = releases.filter(
    (release) => release.tag_name === input.tag || release.name === input.tag,
  );
  if (candidates.some((release) => release.draft === false))
    fail('RELEASE_ALREADY_PUBLISHED');
  if (candidates.length > 1) fail('RELEASE_DRAFT_AMBIGUOUS');
  if (candidates.length === 0) return null;
  assertReleaseIdentity(candidates[0], input, true);
  return candidates[0];
}

export function classifyReleaseState(release, artifacts) {
  if (!release) return RELEASE_STATES.NO_RELEASE;
  if (release.draft === false) return RELEASE_STATES.PUBLISHED;
  if (release.draft !== true || release.prerelease !== false)
    return RELEASE_STATES.INVALID;
  try {
    const names = validateAssetInventory(release, artifacts, false, true);
    if (names.size === 0) return RELEASE_STATES.DRAFT_CREATED;
    return names.size === artifacts.length &&
      (release.assets ?? []).every(({ digest }) => Boolean(digest))
      ? RELEASE_STATES.DRAFT_COMPLETE
      : RELEASE_STATES.DRAFT_PARTIAL;
  } catch {
    return RELEASE_STATES.INVALID;
  }
}

export async function publishReleaseDraftWithPolicy(api, input, policy) {
  if (!policy || input.repository !== policy.repository)
    fail('RELEASE_REPOSITORY_MISMATCH');
  if (
    !(policy.tagPattern instanceof RegExp) ||
    !policy.tagPattern.test(input.tag)
  )
    fail('RELEASE_TAG_INVALID');
  if (!COMMIT_SHA.test(input.sourceCommit))
    fail('RELEASE_SOURCE_COMMIT_INVALID');
  if (
    !Array.isArray(input.artifacts) ||
    input.artifacts.length === 0 ||
    new Set(input.artifacts.map(({ name }) => name)).size !==
      input.artifacts.length
  ) {
    fail('RELEASE_EXPECTED_ASSETS_INVALID');
  }

  let release = selectRelease(await api.listReleases(), input);
  if (!release) {
    let created;
    try {
      created = await api.createDraft({
        tag: input.tag,
        sourceCommit: input.sourceCommit,
        name: input.tag,
        body: `PE Community ${input.tag}`,
      });
    } catch (error) {
      try {
        release = selectRelease(await api.listReleases(), input);
      } catch {
        fail('RELEASE_CREATE_UNKNOWN');
      }
      if (!release) throw new Error('RELEASE_CREATE_UNKNOWN', { cause: error });
    }
    if (!release) {
      assertReleaseIdentity(created, input, true);
      release = await readReleaseWithRetry(api, created.id, input, true);
    }
  }

  assertReleaseIdentity(release, input, true);
  const existingNames = validateAssetInventory(
    release,
    input.artifacts,
    false,
    true,
  );
  for (const artifact of input.artifacts) {
    if (existingNames.has(artifact.name)) continue;
    try {
      await api.uploadAsset(release, artifact);
    } catch (error) {
      try {
        release = await readReleaseWithRetry(
          api,
          release.id,
          input,
          true,
          false,
          artifact.name,
        );
      } catch (reconciliationError) {
        if (
          reconciliationError instanceof Error &&
          [
            'RELEASE_ASSET_DUPLICATE',
            'RELEASE_ASSET_UNEXPECTED',
            'RELEASE_ASSET_SIZE_MISMATCH',
            'RELEASE_ASSET_DIGEST_MISMATCH',
          ].includes(reconciliationError.message)
        ) {
          throw reconciliationError;
        }
        throw new Error('RELEASE_ASSET_UPLOAD_UNKNOWN', { cause: error });
      }
    }
  }

  release = await readReleaseWithRetry(api, release.id, input, true, true);

  try {
    await api.publishRelease(release.id, {
      tag: input.tag,
      sourceCommit: input.sourceCommit,
      name: input.tag,
    });
  } catch (error) {
    try {
      return await readReleaseWithRetry(api, release.id, input, false, true);
    } catch {
      throw new Error('RELEASE_PUBLISH_UNKNOWN', { cause: error });
    }
  }

  let verified;
  try {
    verified = await readReleaseWithRetry(api, release.id, input, false, true);
  } catch (error) {
    throw new Error('RELEASE_PUBLISH_UNKNOWN', { cause: error });
  }
  if (
    !verified.html_url?.endsWith(
      `/releases/tag/${encodeURIComponent(input.tag)}`,
    )
  ) {
    fail('RELEASE_URL_MISMATCH');
  }
  return verified;
}

export async function publishReleaseDraft(api, input) {
  if (input.repository !== PRODUCTION_RELEASE_POLICY.repository)
    fail('RELEASE_REPOSITORY_MISMATCH');
  if (!PRODUCTION_RELEASE_POLICY.tagPattern.test(input.tag))
    fail('RELEASE_TAG_INVALID');
  const expectedArtifacts = new Set([
    'pe-community-update-manifest.json',
    'pe-community-update-manifest.attestation.jsonl',
    'pe-community-api.attestation.jsonl',
    'pe-community-web.attestation.jsonl',
    'pe-community-worker.attestation.jsonl',
    `pe-community-updater-${input.tag}-linux-amd64.tar.gz`,
    `pe-community-updater-${input.tag}-linux-arm64.tar.gz`,
  ]);
  if (
    input.artifacts.length !== expectedArtifacts.size ||
    input.artifacts.some(({ name }) => !expectedArtifacts.has(name))
  ) {
    fail('RELEASE_EXPECTED_ASSETS_INVALID');
  }
  return publishReleaseDraftWithPolicy(api, input, PRODUCTION_RELEASE_POLICY);
}

export class GitHubReleaseApi {
  constructor(repository, token, fetchImpl = fetch) {
    this.repository = repository;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(url, init = {}) {
    const response = await this.fetch(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'pe-community-release-publisher',
        ...init.headers,
      },
    });
    if (!response.ok) fail(`GITHUB_API_HTTP_${response.status}`);
    return response;
  }

  async listReleases() {
    const releases = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.request(
        `https://api.github.com/repos/${this.repository}/releases?per_page=100&page=${page}`,
      );
      const batch = await response.json();
      if (!Array.isArray(batch)) fail('GITHUB_RELEASE_LIST_INVALID');
      releases.push(...batch);
      if (batch.length < 100) return releases;
    }
    fail('GITHUB_RELEASE_LIST_PAGINATION_LIMIT');
  }

  async createDraft(input) {
    const response = await this.request(
      `https://api.github.com/repos/${this.repository}/releases`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: input.tag,
          target_commitish: input.sourceCommit,
          name: input.name,
          body: input.body,
          draft: true,
          prerelease: false,
        }),
      },
    );
    return response.json();
  }

  async uploadAsset(release, artifact) {
    if (typeof release.upload_url !== 'string')
      fail('RELEASE_UPLOAD_URL_MISSING');
    if (!Number.isSafeInteger(release.id) || release.id <= 0)
      fail('RELEASE_ID_INVALID');
    const templateSuffix = '{?name,label}';
    if (!release.upload_url.endsWith(templateSuffix))
      fail('RELEASE_UPLOAD_URL_INVALID');
    const uploadBase = release.upload_url.slice(0, -templateSuffix.length);
    const rawAuthority = /^https:\/\/([^/?#]+)/.exec(uploadBase)?.[1];
    if (rawAuthority !== 'uploads.github.com')
      fail('RELEASE_UPLOAD_URL_INVALID');
    const uploadUrl = new URL(uploadBase);
    const expectedPath = `/repos/${this.repository}/releases/${release.id}/assets`;
    if (
      uploadUrl.protocol !== 'https:' ||
      uploadUrl.hostname !== 'uploads.github.com' ||
      uploadUrl.port !== '' ||
      uploadUrl.username !== '' ||
      uploadUrl.password !== '' ||
      uploadUrl.pathname !== expectedPath ||
      uploadUrl.search !== '' ||
      uploadUrl.hash !== ''
    ) {
      fail('RELEASE_UPLOAD_URL_INVALID');
    }
    uploadUrl.searchParams.set('name', artifact.name);
    const response = await this.request(uploadUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: artifact.content,
    });
    return response.json();
  }

  async getRelease(releaseId) {
    const response = await this.request(
      `https://api.github.com/repos/${this.repository}/releases/${releaseId}`,
    );
    return response.json();
  }

  async publishRelease(releaseId, input) {
    const response = await this.request(
      `https://api.github.com/repos/${this.repository}/releases/${releaseId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: input.tag,
          target_commitish: input.sourceCommit,
          name: input.name,
          draft: false,
          prerelease: false,
          make_latest: input.tag === VALIDATION_FIXTURE_TAG ? 'false' : 'true',
        }),
      },
    );
    return response.json();
  }
}

async function loadArtifact(path, name = basename(path)) {
  const [content, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    name,
    content,
    size: metadata.size,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const tag = process.env.RELEASE_TAG ?? '';
  const sourceCommit = process.env.SOURCE_COMMIT ?? '';
  const token = process.env.GH_TOKEN ?? '';
  const version = process.env.VERSION ?? '';
  const artifactDirectory = process.env.RELEASE_ARTIFACT_DIRECTORY ?? '.';
  if (!token) fail('GITHUB_TOKEN_REQUIRED');
  if (version !== tag) fail('RELEASE_VERSION_MISMATCH');

  const names = [
    'pe-community-update-manifest.json',
    'pe-community-update-manifest.attestation.jsonl',
    'pe-community-api.attestation.jsonl',
    'pe-community-web.attestation.jsonl',
    'pe-community-worker.attestation.jsonl',
    `pe-community-updater-${version}-linux-amd64.tar.gz`,
    `pe-community-updater-${version}-linux-arm64.tar.gz`,
  ];
  const artifacts = await Promise.all(
    names.map((name) => loadArtifact(join(artifactDirectory, name), name)),
  );
  const release = await publishReleaseDraft(
    new GitHubReleaseApi(repository, token),
    {
      repository,
      tag,
      sourceCommit,
      artifacts,
    },
  );
  console.log(
    `Published validated release ${release.tag_name} (release ID ${release.id}).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'RELEASE_PUBLICATION_FAILED',
    );
    process.exitCode = 1;
  });
}
