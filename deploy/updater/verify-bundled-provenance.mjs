import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provenanceVerifierArgs } from '../../apps/updater/dist/provenance.js';

const options = parseArguments(process.argv.slice(2));

const home = mkdtempSync(join(tmpdir(), 'pe-community-provenance-'));
mkdirSync(join(home, 'gh-config'), { mode: 0o700 });
mkdirSync(join(home, 'docker-config'), { mode: 0o700 });
try {
  execFileSync(
    options.gh,
    provenanceVerifierArgs(
      {
        service: options.service,
        repository: options.repository,
        digest: options.digest,
        bundle: new Uint8Array([1]),
        releaseTag: options.releaseTag,
        sourceCommit: options.sourceCommit,
      },
      options.bundle,
    ),
    {
      env: verifierEnvironment(home),
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
} catch {
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}

function parseArguments(argumentsList) {
  const names = new Set([
    '--gh',
    '--bundle',
    '--service',
    '--repository',
    '--digest',
    '--release-tag',
    '--source-commit',
  ]);
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!names.has(name) || !value || name in values)
      throw new Error('Invalid bundled provenance verifier arguments.');
    values[name] = value;
  }
  if (Object.keys(values).length !== names.size)
    throw new Error('Missing bundled provenance verifier arguments.');
  if (!['api', 'web', 'worker'].includes(values['--service']))
    throw new Error('Invalid bundled provenance service.');
  return {
    gh: values['--gh'],
    bundle: values['--bundle'],
    service: values['--service'],
    repository: values['--repository'],
    digest: values['--digest'],
    releaseTag: values['--release-tag'],
    sourceCommit: values['--source-commit'],
  };
}

function verifierEnvironment(home) {
  return {
    HOME: home,
    GH_CONFIG_DIR: join(home, 'gh-config'),
    DOCKER_CONFIG: join(home, 'docker-config'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: '/usr/bin:/bin',
  };
}
