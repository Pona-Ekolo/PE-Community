import { createHash } from 'node:crypto';

export const GITHUB_CLI_VERSION = '2.93.0';

export const GITHUB_CLI_PINS = Object.freeze({
  'linux-amd64': Object.freeze({
    archive: 'gh_2.93.0_linux_amd64.tar.gz',
    url: 'https://github.com/cli/cli/releases/download/v2.93.0/gh_2.93.0_linux_amd64.tar.gz',
    sha256: '02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0',
  }),
  'linux-arm64': Object.freeze({
    archive: 'gh_2.93.0_linux_arm64.tar.gz',
    url: 'https://github.com/cli/cli/releases/download/v2.93.0/gh_2.93.0_linux_arm64.tar.gz',
    sha256: 'c55feb33684abba57e9909737340d5b39282257c0363e1edde6785ac4a413be7',
  }),
});

export function updaterAssetName(version, architecture) {
  pinFor(architecture);
  return `pe-community-updater-${version}-${architecture}.tar.gz`;
}

export function pinFor(architecture) {
  const pin = GITHUB_CLI_PINS[architecture];
  if (!pin) throw new Error('UPDATER_BUNDLE_ARCHITECTURE_UNSUPPORTED');
  return pin;
}

export function verifyPinnedArchive(bytes, architecture) {
  const pin = pinFor(architecture);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.sha256)
    throw new Error('UPDATER_BUNDLE_GH_CHECKSUM_MISMATCH');
}

export function verifyUpstreamArchiveEntries(entries, architecture) {
  const root = `gh_${GITHUB_CLI_VERSION}_${architecture.replace('-', '_')}`;
  const required = new Set([`${root}/LICENSE`, `${root}/bin/gh`]);
  for (const entry of entries) {
    if (
      !entry.startsWith(`${root}/`) ||
      entry.includes('..') ||
      entry.startsWith('/')
    )
      throw new Error('UPDATER_BUNDLE_GH_LAYOUT_INVALID');
    required.delete(entry);
  }
  if (required.size !== 0) throw new Error('UPDATER_BUNDLE_GH_LAYOUT_INVALID');
}

export function verifyBundleEntries(entries) {
  const required = new Set([
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
  ]);
  for (const entry of entries) {
    if (
      !entry.startsWith('pe-community-updater/') ||
      entry.includes('..') ||
      /(?:^|\/)node_modules(?:\/|$)|(?:^|\/)\.git(?:\/|$)|(?:^|\/)\.env(?:$|\.)|(?:^|\/)(?:test|tests|test-fixture)(?:\/|$)|(?:^|\/)report-[^/]+$/.test(
        entry,
      )
    )
      throw new Error('UPDATER_BUNDLE_INVENTORY_INVALID');
    required.delete(entry);
  }
  if (required.size !== 0) throw new Error('UPDATER_BUNDLE_INVENTORY_INVALID');
}
