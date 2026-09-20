import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyReleaseState,
  GitHubReleaseApi,
  publishReleaseDraft,
  READ_RETRY_DELAYS_MS,
  RELEASE_STATES,
} from './publish-release-draft.mjs';

const repository = 'Pona-Ekolo/PE-Community';
const tag = 'v1.2.5';
const sourceCommit = 'f2ad9c87a149b6506fbc9d290cb118ab94d236a4';
const artifacts = [
  {
    name: 'pe-community-update-manifest.json',
    size: 10,
    digest: `sha256:${'a'.repeat(64)}`,
  },
  {
    name: 'pe-community-update-manifest.attestation.jsonl',
    size: 20,
    digest: `sha256:${'b'.repeat(64)}`,
  },
  {
    name: 'pe-community-api.attestation.jsonl',
    size: 21,
    digest: `sha256:${'e'.repeat(64)}`,
  },
  {
    name: 'pe-community-web.attestation.jsonl',
    size: 22,
    digest: `sha256:${'f'.repeat(64)}`,
  },
  {
    name: 'pe-community-worker.attestation.jsonl',
    size: 23,
    digest: `sha256:${'0'.repeat(64)}`,
  },
  {
    name: `pe-community-updater-${tag}-linux-amd64.tar.gz`,
    size: 30,
    digest: `sha256:${'c'.repeat(64)}`,
  },
  {
    name: `pe-community-updater-${tag}-linux-arm64.tar.gz`,
    size: 40,
    digest: `sha256:${'d'.repeat(64)}`,
  },
];
const input = { repository, tag, sourceCommit, artifacts };

function validationFixtureInput() {
  return {
    ...input,
    tag: 'v0.0.0',
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      name: artifact.name.replaceAll(tag, 'v0.0.0'),
    })),
  };
}

function asset(artifact, id) {
  return {
    id,
    name: artifact.name,
    size: artifact.size,
    digest: artifact.digest,
    state: 'uploaded',
  };
}

function draft(overrides = {}) {
  return {
    id: 41,
    tag_name: tag,
    name: tag,
    draft: true,
    prerelease: false,
    target_commitish: sourceCommit,
    upload_url:
      'https://uploads.github.com/repos/Pona-Ekolo/PE-Community/releases/41/assets{?name,label}',
    html_url:
      'https://github.com/Pona-Ekolo/PE-Community/releases/tag/untagged-c1767672324eb91ee125',
    assets: [],
    ...overrides,
  };
}

class FakeApi {
  constructor(releases = []) {
    this.releases = structuredClone(releases);
    this.calls = [];
    this.createdDraftUrls = [];
    this.nextId = 100;
  }

  async listReleases() {
    this.calls.push('list');
    return structuredClone(this.releases);
  }

  async createDraft(createInput) {
    this.calls.push('create');
    const release = draft({
      id: this.nextId++,
      tag_name: createInput.tag,
      name: createInput.name,
      target_commitish: createInput.sourceCommit,
    });
    this.createdDraftUrls.push(release.html_url);
    this.releases.push(release);
    return structuredClone(release);
  }

  async uploadAsset(id, artifact) {
    this.calls.push(`upload:${artifact.name}`);
    const release = this.releases.find(
      (candidate) => candidate.id === (typeof id === 'object' ? id.id : id),
    );
    const uploaded = asset(artifact, this.nextId++);
    release.assets.push(uploaded);
    return structuredClone(uploaded);
  }

  async getRelease(id) {
    this.calls.push(`get:${id}`);
    return structuredClone(
      this.releases.find((candidate) => candidate.id === id),
    );
  }

  async publishRelease(id, publishInput) {
    this.calls.push(`publish:${id}`);
    const release = this.releases.find((candidate) => candidate.id === id);
    release.draft = false;
    release.html_url = `https://github.com/Pona-Ekolo/PE-Community/releases/tag/${publishInput.tag}`;
    return structuredClone(release);
  }
}

class ConfigurableApi extends FakeApi {
  constructor(releases = [], options = {}) {
    super(releases);
    this.options = { ...options };
    this.getCount = 0;
  }

  async createDraft(createInput) {
    if (this.options.createFailureWithoutResource) {
      this.calls.push('create');
      throw new Error('NETWORK_FAILURE');
    }
    const created = await super.createDraft(createInput);
    if (this.options.createFailure) throw new Error('NETWORK_FAILURE');
    return created;
  }

  async getRelease(id) {
    this.getCount += 1;
    if (this.options.get404Remaining > 0) {
      this.options.get404Remaining -= 1;
      throw new Error('GITHUB_API_HTTP_404');
    }
    const release = await super.getRelease(id);
    if (this.options.incompleteRemaining > 0) {
      this.options.incompleteRemaining -= 1;
      return { ...release, assets: [] };
    }
    if (this.options.digestMissingRemaining > 0) {
      this.options.digestMissingRemaining -= 1;
      return {
        ...release,
        assets: release.assets.map((candidate) => ({
          ...candidate,
          digest: null,
        })),
      };
    }
    if (this.options.publishStaleRemaining > 0 && release.draft === false) {
      this.options.publishStaleRemaining -= 1;
      return { ...release, draft: true };
    }
    return release;
  }

  async uploadAsset(release, artifact) {
    if (this.options.uploadFailureWithoutAsset) {
      this.calls.push(`upload:${artifact.name}`);
      throw new Error('NETWORK_FAILURE');
    }
    const uploaded = await super.uploadAsset(release, artifact);
    if (this.options.uploadFailure) throw new Error('NETWORK_FAILURE');
    return uploaded;
  }

  async publishRelease(id, input) {
    const published = await super.publishRelease(id, input);
    if (this.options.publishFailure) throw new Error('NETWORK_FAILURE');
    return published;
  }
}

async function expectFailure(api, expected, customInput = input) {
  await assert.rejects(
    () => publishReleaseDraft(api, customInput),
    new RegExp(expected),
  );
  assert.equal(
    api.calls.some((call) => call.startsWith('publish:')),
    false,
  );
}

test('creates, rediscovers, fills, validates, and publishes a new draft by release ID', async () => {
  const api = new FakeApi();
  const result = await publishReleaseDraft(api, input);
  assert.equal(result.draft, false);
  assert.equal(api.calls.filter((call) => call === 'create').length, 1);
  assert.equal(
    api.calls.filter((call) => call.startsWith('upload:')).length,
    artifacts.length,
  );
  assert.ok(api.calls.includes('publish:100'));
});

test('publishes the validation fixture through the same exact seven-asset draft-first path', async () => {
  const fixtureInput = validationFixtureInput();
  const api = new FakeApi();
  const result = await publishReleaseDraft(api, fixtureInput);
  assert.equal(result.tag_name, 'v0.0.0');
  assert.equal(result.draft, false);
  assert.equal(fixtureInput.artifacts.length, 7);
  assert.deepEqual(
    fixtureInput.artifacts.map(({ name }) => name),
    [
      'pe-community-update-manifest.json',
      'pe-community-update-manifest.attestation.jsonl',
      'pe-community-api.attestation.jsonl',
      'pe-community-web.attestation.jsonl',
      'pe-community-worker.attestation.jsonl',
      'pe-community-updater-v0.0.0-linux-amd64.tar.gz',
      'pe-community-updater-v0.0.0-linux-arm64.tar.gz',
    ],
  );
  assert.equal(api.calls[0], 'list');
  assert.equal(api.calls[1], 'create');
  assert.equal(
    api.calls.filter((call) => call.startsWith('upload:')).length,
    7,
  );
  assert.ok(api.calls.includes('publish:100'));
});

test('marks only the permanent validation fixture as non-latest', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{}', { status: 200 });
  };
  const api = new GitHubReleaseApi(repository, 'test-token', fetchImpl);
  await api.publishRelease(41, {
    tag: 'v0.0.0',
    sourceCommit,
    name: 'v0.0.0',
  });
  await api.publishRelease(42, { tag, sourceCommit, name: tag });
  assert.equal(calls[0].body.make_latest, 'false');
  assert.equal(calls[0].body.draft, false);
  assert.equal(calls[0].body.prerelease, false);
  assert.equal(calls[1].body.make_latest, 'true');
});

test('uses the created draft ID rather than its temporary untagged URL', async () => {
  const api = new FakeApi();
  api.nextId = 123456;
  const result = await publishReleaseDraft(api, input);
  assert.equal(result.id, 123456);
  assert.equal(result.tag_name, tag);
  assert.equal(result.draft, false);
  assert.equal(
    api.createdDraftUrls[0],
    'https://github.com/Pona-Ekolo/PE-Community/releases/tag/untagged-c1767672324eb91ee125',
  );
  assert.ok(api.calls.includes('get:123456'));
  assert.ok(api.calls.includes('publish:123456'));
});

test('leaves a newly created draft unpublished when upload reconciliation fails', async () => {
  const api = new ConfigurableApi([], { uploadFailureWithoutAsset: true });
  await assert.rejects(
    () => publishReleaseDraft(api, input),
    /RELEASE_ASSET_UPLOAD_UNKNOWN/,
  );
  assert.equal(api.releases[0].draft, true);
  assert.equal(
    api.calls.some((call) => call.startsWith('publish:')),
    false,
  );
});

test('resumes a listed draft when the public tag lookup would return 404', async () => {
  const api = new FakeApi([draft()]);
  await publishReleaseDraft(api, input);
  assert.equal(api.calls.includes('create'), false);
  assert.ok(api.calls.includes('publish:41'));
});

test('resumes an exactly matching empty draft', async () => {
  const api = new FakeApi([draft()]);
  await publishReleaseDraft(api, input);
  assert.equal(
    api.calls.filter((call) => call.startsWith('upload:')).length,
    artifacts.length,
  );
});

test('keeps an exact existing asset and uploads only missing assets', async () => {
  const api = new FakeApi([draft({ assets: [asset(artifacts[0], 50)] })]);
  await publishReleaseDraft(api, input);
  assert.equal(api.calls.includes(`upload:${artifacts[0].name}`), false);
  assert.equal(
    api.calls.filter((call) => call.startsWith('upload:')).length,
    artifacts.length - 1,
  );
});

test('fails closed on an existing asset with the wrong digest or size', async () => {
  for (const changed of [
    { ...asset(artifacts[0], 50), digest: `sha256:${'d'.repeat(64)}` },
    { ...asset(artifacts[0], 50), size: 11 },
  ]) {
    const api = new FakeApi([draft({ assets: [changed] })]);
    await expectFailure(api, 'RELEASE_ASSET_(DIGEST|SIZE)_MISMATCH');
    assert.equal(
      api.calls.some((call) => call.startsWith('upload:')),
      false,
    );
  }
});

test('fails closed on an unexpected extra asset', async () => {
  const api = new FakeApi([
    draft({
      assets: [
        {
          id: 50,
          name: 'unexpected.txt',
          size: 1,
          digest: `sha256:${'d'.repeat(64)}`,
        },
      ],
    }),
  ]);
  await expectFailure(api, 'RELEASE_ASSET_UNEXPECTED');
});

test('aborts without mutation when a published release already exists', async () => {
  const api = new FakeApi([draft({ draft: false })]);
  await expectFailure(api, 'RELEASE_ALREADY_PUBLISHED');
  assert.deepEqual(api.calls, ['list']);
});

test('production publisher remains bound to its repository and stable semver tags', async () => {
  const testRepositoryApi = new FakeApi();
  await expectFailure(testRepositoryApi, 'RELEASE_REPOSITORY_MISMATCH', {
    ...input,
    repository: 'Pona-Ekolo/PE-Community-Release-Test',
  });
  assert.deepEqual(testRepositoryApi.calls, []);
  const testTagApi = new FakeApi();
  await expectFailure(testTagApi, 'RELEASE_TAG_INVALID', {
    ...input,
    tag: 'release-test-audit-run-clean',
  });
  assert.deepEqual(testTagApi.calls, []);
});

test('fails closed when multiple matching drafts are present', async () => {
  const api = new FakeApi([draft(), draft({ id: 42 })]);
  await expectFailure(api, 'RELEASE_DRAFT_AMBIGUOUS');
});

test('fails closed when a candidate has the wrong tag or target commit', async () => {
  await expectFailure(
    new FakeApi([draft({ tag_name: 'v1.2.0' })]),
    'RELEASE_TAG_MISMATCH',
  );
  await expectFailure(
    new FakeApi([draft({ target_commitish: '0'.repeat(40) })]),
    'RELEASE_TARGET_MISMATCH',
  );
});

test('rerun after partial upload does not duplicate the release or exact assets', async () => {
  const api = new FakeApi([
    draft({ assets: [asset(artifacts[0], 50), asset(artifacts[1], 51)] }),
  ]);
  await publishReleaseDraft(api, input);
  assert.equal(api.calls.includes('create'), false);
  assert.deepEqual(
    api.calls.filter((call) => call.startsWith('upload:')),
    artifacts.slice(2).map(({ name }) => `upload:${name}`),
  );
  assert.equal(
    new Set(api.releases[0].assets.map(({ name }) => name)).size,
    artifacts.length,
  );
});

test('does not require a just-created release to appear in the collection listing', async () => {
  const api = new ConfigurableApi();
  await publishReleaseDraft(api, input);
  assert.equal(api.calls.filter((call) => call === 'list').length, 1);
});

test('retries a transient ID read without creating a second release', async () => {
  const api = new ConfigurableApi([], { get404Remaining: 1 });
  await publishReleaseDraft(api, input);
  assert.equal(api.calls.filter((call) => call === 'create').length, 1);
  assert.equal(api.calls.filter((call) => call === 'publish:100').length, 1);
});

test('fails closed when the created release never becomes readable by ID', async () => {
  const api = new ConfigurableApi([], { get404Remaining: 10 });
  await assert.rejects(
    () => publishReleaseDraft(api, input),
    /RELEASE_CREATE_READ_TIMEOUT/,
  );
  assert.equal(api.calls.filter((call) => call === 'create').length, 1);
  assert.equal(api.getCount, READ_RETRY_DELAYS_MS.length + 1);
});

test('retries incomplete asset visibility and a temporarily missing digest', async () => {
  const api = new ConfigurableApi([], {
    incompleteRemaining: 1,
    digestMissingRemaining: 1,
  });
  await publishReleaseDraft(api, input);
  assert.ok(api.calls.includes('publish:100'));
});

test('reconciles an unknown create outcome through listing without a second POST', async () => {
  const api = new ConfigurableApi([], { createFailure: true });
  await publishReleaseDraft(api, input);
  assert.equal(api.calls.filter((call) => call === 'create').length, 1);
  assert.equal(
    api.calls.filter((call) => call.startsWith('upload:')).length,
    artifacts.length,
  );
});

test('does not retry a create POST when the outcome is unknown and no draft is listed', async () => {
  const api = new ConfigurableApi([], { createFailureWithoutResource: true });
  await assert.rejects(
    () => publishReleaseDraft(api, input),
    /RELEASE_CREATE_UNKNOWN/,
  );
  assert.equal(api.calls.filter((call) => call === 'create').length, 1);
});

test('reconciles an unknown publication outcome by reading the same ID', async () => {
  const api = new ConfigurableApi([], { publishFailure: true });
  const result = await publishReleaseDraft(api, input);
  assert.equal(result.draft, false);
  assert.equal(api.calls.filter((call) => call === 'publish:100').length, 1);
});

test('retries publication verification when the first read still reports a draft', async () => {
  const api = new ConfigurableApi([], { publishStaleRemaining: 1 });
  const result = await publishReleaseDraft(api, input);
  assert.equal(result.draft, false);
});

test('fails closed when publication state never converges', async () => {
  const api = new ConfigurableApi([], { publishStaleRemaining: 10 });
  await assert.rejects(
    () => publishReleaseDraft(api, input),
    /RELEASE_PUBLISH_UNKNOWN/,
  );
  assert.equal(api.calls.filter((call) => call === 'publish:100').length, 1);
});

test('classifies the explicit release states from safe release metadata', () => {
  assert.equal(
    classifyReleaseState(null, artifacts),
    RELEASE_STATES.NO_RELEASE,
  );
  assert.equal(
    classifyReleaseState(draft(), artifacts),
    RELEASE_STATES.DRAFT_CREATED,
  );
  assert.equal(
    classifyReleaseState(
      draft({ assets: [asset(artifacts[0], 50)] }),
      artifacts,
    ),
    RELEASE_STATES.DRAFT_PARTIAL,
  );
  assert.equal(
    classifyReleaseState(
      draft({
        assets: artifacts.map((candidate, index) => asset(candidate, index)),
      }),
      artifacts,
    ),
    RELEASE_STATES.DRAFT_COMPLETE,
  );
  assert.equal(
    classifyReleaseState(draft({ draft: false }), artifacts),
    RELEASE_STATES.PUBLISHED,
  );
  assert.equal(
    classifyReleaseState(draft({ prerelease: true }), artifacts),
    RELEASE_STATES.INVALID,
  );
});

test('reconciles an unknown asset upload outcome without uploading it twice', async () => {
  const api = new ConfigurableApi([], { uploadFailure: true });
  await publishReleaseDraft(api, input);
  assert.equal(
    api.calls.filter((call) => call.startsWith('upload:')).length,
    artifacts.length,
  );
});

test('uploads through the validated release-specific upload URL', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  };
  const api = new GitHubReleaseApi(repository, 'test-token', fetchImpl);
  await api.uploadAsset(draft(), artifacts[0]);
  assert.match(
    calls[0].url,
    /^https:\/\/uploads\.github\.com\/repos\/Pona-Ekolo\/PE-Community\/releases\/41\/assets\?name=/,
  );
  assert.equal(calls[0].init.method, 'POST');
  for (const uploadUrl of [
    'https://uploads.github.com/repos/Other/PE-Community/releases/41/assets{?name,label}',
    'https://uploads.github.com/repos/Pona-Ekolo/PE-Community/releases/42/assets{?name,label}',
    'https://uploads.github.com/repos/Pona-Ekolo/PE-Community/releases/41/assets?unexpected=1{?name,label}',
    'http://uploads.github.com/repos/Pona-Ekolo/PE-Community/releases/41/assets{?name,label}',
    'https://example.test/repos/Pona-Ekolo/PE-Community/releases/41/assets{?name,label}',
    'https://uploads.github.com:443/repos/Pona-Ekolo/PE-Community/releases/41/assets{?name,label}',
  ]) {
    await assert.rejects(
      () =>
        api.uploadAsset({ ...draft(), upload_url: uploadUrl }, artifacts[0]),
      /RELEASE_UPLOAD_URL_INVALID/,
    );
  }
});
