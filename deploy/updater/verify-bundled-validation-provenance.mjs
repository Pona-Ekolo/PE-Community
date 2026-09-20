import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const services = Object.freeze({
  api: 'ghcr.io/pona-ekolo/pe-community-api',
  web: 'ghcr.io/pona-ekolo/pe-community-web',
  worker: 'ghcr.io/pona-ekolo/pe-community-worker',
});
const options = parseArguments(process.argv.slice(2));

const home = mkdtempSync(join(tmpdir(), 'pe-community-validation-'));
mkdirSync(join(home, 'gh-config'), { mode: 0o700 });
mkdirSync(join(home, 'docker-config'), { mode: 0o700 });
try {
  execFileSync(
    options.gh,
    [
      'attestation',
      'verify',
      `oci://${services[options.service]}@${options.digest}`,
      '--bundle',
      options.bundle,
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
      'refs/heads/main',
      '--source-digest',
      options.sourceCommit,
      '--deny-self-hosted-runners',
      '--limit',
      '10',
      '--format',
      'json',
    ],
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
    '--digest',
    '--source-commit',
  ]);
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!names.has(name) || !value || name in values)
      throw new Error('Invalid bundled validation verifier arguments.');
    values[name] = value;
  }
  if (Object.keys(values).length !== names.size)
    throw new Error('Missing bundled validation verifier arguments.');
  if (!(values['--service'] in services))
    throw new Error('Invalid bundled validation service.');
  if (!/^sha256:[a-f0-9]{64}$/.test(values['--digest']))
    throw new Error('Invalid bundled validation digest.');
  if (!/^[a-f0-9]{40}$/.test(values['--source-commit']))
    throw new Error('Invalid bundled validation source commit.');
  return {
    gh: values['--gh'],
    bundle: values['--bundle'],
    service: values['--service'],
    digest: values['--digest'],
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
