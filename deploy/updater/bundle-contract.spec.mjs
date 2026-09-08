import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GITHUB_CLI_PINS,
  GITHUB_CLI_VERSION,
  updaterAssetName,
  verifyBundleEntries,
  verifyPinnedArchive,
  verifyUpstreamArchiveEntries,
} from './bundle-contract.mjs';

test('pins immutable official GitHub CLI archives for both supported Linux architectures', () => {
  assert.equal(GITHUB_CLI_VERSION, '2.93.0');
  for (const [architecture, archive] of [
    ['linux-amd64', 'gh_2.93.0_linux_amd64.tar.gz'],
    ['linux-arm64', 'gh_2.93.0_linux_arm64.tar.gz'],
  ]) {
    const pin = GITHUB_CLI_PINS[architecture];
    assert.ok(pin);
    assert.match(pin.url, new RegExp(`/v${GITHUB_CLI_VERSION}/`));
    assert.equal(pin.archive, archive);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      updaterAssetName('v1.2.3', architecture),
      `pe-community-updater-v1.2.3-${architecture}.tar.gz`,
    );
  }
  assert.throws(
    () => updaterAssetName('v1.2.3', 'linux-s390x'),
    /UPDATER_BUNDLE_ARCHITECTURE_UNSUPPORTED/,
  );
});

test('checksum and upstream archive layout failures block packaging', () => {
  assert.throws(
    () => verifyPinnedArchive(Buffer.from('wrong'), 'linux-amd64'),
    /UPDATER_BUNDLE_GH_CHECKSUM_MISMATCH/,
  );
  assert.doesNotThrow(() =>
    verifyUpstreamArchiveEntries(
      ['gh_2.93.0_linux_amd64/LICENSE', 'gh_2.93.0_linux_amd64/bin/gh'],
      'linux-amd64',
    ),
  );
  assert.throws(
    () => verifyUpstreamArchiveEntries(['other/bin/gh'], 'linux-amd64'),
    /UPDATER_BUNDLE_GH_LAYOUT_INVALID/,
  );
});

test('updater bundle inventory requires the embedded verifier and license', () => {
  const entries = [
    'pe-community-updater/bin/pe-community-updater',
    'pe-community-updater/bin/gh',
    'pe-community-updater/dist/cli.js',
    'pe-community-updater/dist/server.js',
    'pe-community-updater/package.json',
    'pe-community-updater/LICENSES/github-cli-MIT.txt',
    'pe-community-updater/deploy/README.md',
    'pe-community-updater/deploy/SECURITY.md',
    'pe-community-updater/deploy/pe-community-updater.service',
    'pe-community-updater/deploy/pe-community-updater.env.example',
    'pe-community-updater/deploy/docker-compose.updater.yml',
    'pe-community-updater/deploy/install.sh',
  ];
  assert.doesNotThrow(() => verifyBundleEntries(entries));
  assert.throws(
    () =>
      verifyBundleEntries(
        entries.filter((entry) => entry !== 'pe-community-updater/bin/gh'),
      ),
    /UPDATER_BUNDLE_INVENTORY_INVALID/,
  );
  for (const unexpected of [
    'pe-community-updater/node_modules/gh/index.js',
    'pe-community-updater/.env',
    'pe-community-updater/.git/config',
    'pe-community-updater/test-fixture/secret.txt',
    'pe-community-updater/report-private.md',
  ]) {
    assert.throws(
      () => verifyBundleEntries([...entries, unexpected]),
      /UPDATER_BUNDLE_INVENTORY_INVALID/,
    );
  }
});
