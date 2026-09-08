import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ProcessCommandExecutor } from './executor.js';
import {
  GitHubCliManifestAttestationVerifier,
  GitHubCliProvenanceVerifier,
  type ProvenanceVerifier,
} from './provenance.js';
import { GitHubReleaseProvider, type ReleaseProvider } from './release.js';
import {
  digestPinnedComposeOverride,
  verifyRelease,
  type ReleaseVerification,
} from './release-verifier.js';

type CliOutput = Pick<Console, 'log' | 'error'>;

const VERIFY_RELEASE_USAGE =
  'Usage: pe-community-updater verify-release vX.Y.Z [--json] [--output-plan FILE]';

type CliDependencies = {
  releases: ReleaseProvider;
  provenance: ProvenanceVerifier;
  output: CliOutput;
  writePlan: (path: string, content: string) => Promise<void>;
};

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = productionDependencies(),
): Promise<number> {
  if (isHelpRequest(args)) {
    dependencies.output.log(VERIFY_RELEASE_USAGE);
    return 0;
  }
  const parsed = parseVerifyReleaseArgs(args);
  if (!parsed) {
    dependencies.output.error(VERIFY_RELEASE_USAGE);
    return 64;
  }
  try {
    const verification = await verifyRelease({
      version: parsed.version,
      releases: dependencies.releases,
      provenance: dependencies.provenance,
    });
    if (parsed.outputPlan)
      await dependencies.writePlan(
        parsed.outputPlan,
        digestPinnedComposeOverride(verification),
      );
    if (parsed.json)
      dependencies.output.log(JSON.stringify(jsonOutput(verification)));
    else printHuman(verification, dependencies.output);
    return 0;
  } catch (error) {
    dependencies.output.error(
      `Release verification failed: ${errorCode(error)}`,
    );
    return 1;
  }
}

function isHelpRequest(args: readonly string[]) {
  const help = new Set(['--help', '-h', 'help']);
  return (
    (args.length === 1 && help.has(args[0] ?? '')) ||
    (args.length === 2 &&
      args[0] === 'verify-release' &&
      help.has(args[1] ?? ''))
  );
}

function productionDependencies(): CliDependencies {
  const executor = new ProcessCommandExecutor();
  return {
    releases: new GitHubReleaseProvider(
      fetch,
      new GitHubCliManifestAttestationVerifier(executor),
    ),
    provenance: new GitHubCliProvenanceVerifier(executor),
    output: console,
    writePlan: async (path, content) =>
      writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
  };
}

function parseVerifyReleaseArgs(args: readonly string[]) {
  if (args[0] !== 'verify-release' || typeof args[1] !== 'string') return null;
  let json = false;
  let outputPlan: string | null = null;
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === '--json' && !json) {
      json = true;
      continue;
    }
    if (args[index] === '--output-plan' && !outputPlan) {
      const path = args[index + 1];
      if (!path || path.startsWith('-')) return null;
      outputPlan = path;
      index += 1;
      continue;
    }
    return null;
  }
  return { version: args[1], json, outputPlan };
}

function printHuman(verification: ReleaseVerification, output: CliOutput) {
  const images = verification.release.manifest.images;
  output.log('PE Community Release Verification');
  output.log('');
  output.log(`[ok] Release: ${verification.release.version}`);
  output.log('[ok] Manifest provenance verified');
  output.log('[ok] API provenance verified');
  output.log('[ok] Web provenance verified');
  output.log('[ok] Worker provenance verified');
  output.log('');
  for (const [label, service] of [
    ['API', 'api'],
    ['Web', 'web'],
    ['Worker', 'worker'],
  ] as const) {
    output.log(`${label}:`);
    output.log(`${images[service].repository}@${images[service].digest}`);
    output.log('');
  }
  output.log('Release verification complete.');
}

function jsonOutput(verification: ReleaseVerification) {
  const manifest = verification.release.manifest;
  return {
    release: verification.release.version,
    sourceCommit: manifest.sourceCommit,
    releaseContractVersion: manifest.releaseContractVersion,
    policy: {
      strategy: manifest.database.migrationCompatibility,
      requiresManualAction: manifest.requiresManualAction,
    },
    images: manifest.images,
  };
}

function errorCode(error: unknown) {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message))
    return error.message;
  return 'RELEASE_VERIFICATION_FAILED';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
