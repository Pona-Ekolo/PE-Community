import { createHash } from 'node:crypto';
import type { ProvenanceVerificationResult } from './provenance.js';

export const UPDATER_VERSION = '1.4.0';
export const SUPPORTED_RELEASE_CONTRACT_VERSION = 2;
export const UPDATER_PROTOCOL_VERSION = 2;
export const VALIDATION_FIXTURE_VERSION = 'v0.0.0';
export const UPDATE_PHASES = [
  'PENDING',
  'PREFLIGHT',
  'BACKUP',
  'PULLING',
  'VERIFYING',
  'MIGRATING',
  'DEPLOYING',
  'HEALTHCHECK',
  'ROLLING_BACK',
  'COMPLETED',
  'FAILED',
  'MANUAL_INTERVENTION_REQUIRED',
  'CANCELLED',
] as const;

export type UpdatePhase = (typeof UPDATE_PHASES)[number];
export type UpdateLogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';

export type UpdateLogEvent = {
  sequence: number;
  timestamp: string;
  level: UpdateLogLevel;
  phase: UpdatePhase;
  eventCode: string;
  message: string;
};

export type UpdateRun = {
  id: string;
  idempotencyKey: string;
  installedVersion: string;
  targetVersion: string;
  status: UpdatePhase;
  phase: UpdatePhase;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  failureSummary: string | null;
  rollbackStatus:
    | 'NOT_REQUIRED'
    | 'AVAILABLE'
    | 'COMPLETED'
    | 'FAILED'
    | 'UNSAFE';
  releaseMetadataSnapshot: ReleaseManifest | null;
  provenanceResults: ProvenanceVerificationResult[];
  lastSequence: number;
  cancellationRequested: boolean;
};

export type ReleaseManifest = {
  schemaVersion: 2;
  releaseContractVersion: 2;
  version: string;
  channel: 'stable';
  minimumVersion: string;
  minimumUpdaterVersion: string;
  images: Record<
    'api' | 'web' | 'worker',
    { repository: string; digest: string }
  >;
  database: {
    migrationCompatibility:
      | 'NO_MIGRATION'
      | 'BACKWARD_COMPATIBLE'
      | 'FORWARD_ONLY'
      | 'MANUAL_RECOVERY';
  };
  supplyChain: {
    attestationPolicy: 'DIGEST_ONLY' | 'GITHUB_PROVENANCE_REQUIRED';
  };
  requiresManualAction: boolean;
  sourceCommit: string;
  releaseTag: string;
  buildDate?: string;
};

export const ALLOWED_IMAGE_REPOSITORIES = {
  api: 'ghcr.io/pona-ekolo/pe-community-api',
  web: 'ghcr.io/pona-ekolo/pe-community-web',
  worker: 'ghcr.io/pona-ekolo/pe-community-worker',
} as const;

const transitions: Record<UpdatePhase, readonly UpdatePhase[]> = {
  PENDING: ['PREFLIGHT', 'CANCELLED', 'FAILED'],
  PREFLIGHT: ['BACKUP', 'CANCELLED', 'FAILED', 'MANUAL_INTERVENTION_REQUIRED'],
  BACKUP: ['PULLING', 'FAILED', 'MANUAL_INTERVENTION_REQUIRED'],
  PULLING: ['VERIFYING', 'CANCELLED', 'FAILED', 'MANUAL_INTERVENTION_REQUIRED'],
  VERIFYING: ['MIGRATING', 'FAILED', 'MANUAL_INTERVENTION_REQUIRED'],
  MIGRATING: ['DEPLOYING', 'FAILED', 'MANUAL_INTERVENTION_REQUIRED'],
  DEPLOYING: [
    'HEALTHCHECK',
    'ROLLING_BACK',
    'FAILED',
    'MANUAL_INTERVENTION_REQUIRED',
  ],
  HEALTHCHECK: [
    'COMPLETED',
    'ROLLING_BACK',
    'FAILED',
    'MANUAL_INTERVENTION_REQUIRED',
  ],
  ROLLING_BACK: ['FAILED', 'MANUAL_INTERVENTION_REQUIRED'],
  COMPLETED: [],
  FAILED: [],
  MANUAL_INTERVENTION_REQUIRED: [],
  CANCELLED: [],
};

export function transitionRun(
  run: UpdateRun,
  next: UpdatePhase,
  now = new Date(),
): UpdateRun {
  if (!transitions[run.phase].includes(next))
    throw new Error(`Invalid update transition: ${run.phase} -> ${next}`);
  const terminal = [
    'COMPLETED',
    'FAILED',
    'MANUAL_INTERVENTION_REQUIRED',
    'CANCELLED',
  ].includes(next);
  return {
    ...run,
    phase: next,
    status: next,
    startedAt:
      run.startedAt ?? (next === 'PREFLIGHT' ? now.toISOString() : null),
    completedAt: terminal ? now.toISOString() : null,
  };
}

export function canCancel(phase: UpdatePhase) {
  return phase === 'PENDING' || phase === 'PREFLIGHT' || phase === 'PULLING';
}

export function parseVersion(value: unknown): {
  normalized: string;
  parts: [number, number, number];
} {
  if (
    typeof value !== 'string' ||
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)
  )
    throw new Error('INVALID_VERSION');
  const normalized = value;
  const parts = normalized.slice(1).split('.').map(Number) as [
    number,
    number,
    number,
  ];
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error('INVALID_VERSION');
  return { normalized, parts };
}

export function compareVersions(left: string, right: string) {
  const a = parseVersion(left).parts;
  const b = parseVersion(right).parts;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function isValidationFixtureVersion(value: string) {
  return value === VALIDATION_FIXTURE_VERSION;
}

export function validateManifest(value: unknown): ReleaseManifest {
  if (!isObject(value)) throw new Error('MANIFEST_INVALID');
  exactKeys(value, [
    'schemaVersion',
    'releaseContractVersion',
    'version',
    'releaseTag',
    'channel',
    'minimumVersion',
    'minimumUpdaterVersion',
    'images',
    'database',
    'supplyChain',
    'requiresManualAction',
    'sourceCommit',
    'buildDate',
  ]);
  const version = parseVersion(value.version).normalized;
  const releaseTag = parseVersion(value.releaseTag).normalized;
  const minimumVersion = parseVersion(value.minimumVersion).normalized;
  const minimumUpdaterVersion = parseVersion(
    value.minimumUpdaterVersion,
  ).normalized;
  if (
    value.schemaVersion !== 2 ||
    value.channel !== 'stable' ||
    typeof value.requiresManualAction !== 'boolean'
  )
    throw new Error('MANIFEST_INVALID');
  if (value.releaseContractVersion !== SUPPORTED_RELEASE_CONTRACT_VERSION)
    throw new Error('RELEASE_CONTRACT_UNSUPPORTED');
  if (!isObject(value.database)) throw new Error('MANIFEST_INVALID');
  exactKeys(value.database, ['migrationCompatibility']);
  if (
    ![
      'NO_MIGRATION',
      'BACKWARD_COMPATIBLE',
      'FORWARD_ONLY',
      'MANUAL_RECOVERY',
    ].includes(String(value.database.migrationCompatibility))
  )
    throw new Error('MANIFEST_INVALID');
  if (!isObject(value.supplyChain)) throw new Error('MANIFEST_INVALID');
  exactKeys(value.supplyChain, ['attestationPolicy']);
  if (
    !['DIGEST_ONLY', 'GITHUB_PROVENANCE_REQUIRED'].includes(
      String(value.supplyChain.attestationPolicy),
    )
  )
    throw new Error('MANIFEST_INVALID');
  if (!isObject(value.images)) throw new Error('MANIFEST_INVALID');
  exactKeys(value.images, ['api', 'web', 'worker']);
  const manifestImages = value.images;
  const images = Object.fromEntries(
    Object.entries(ALLOWED_IMAGE_REPOSITORIES).map(([service, repository]) => {
      const image = manifestImages[service];
      if (isObject(image)) exactKeys(image, ['repository', 'digest']);
      if (
        !isObject(image) ||
        image.repository !== repository ||
        typeof image.digest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(image.digest)
      ) {
        throw new Error('MANIFEST_IMAGE_INVALID');
      }
      return [service, { repository, digest: image.digest }];
    }),
  ) as ReleaseManifest['images'];
  if (releaseTag !== version)
    throw new Error('PROVENANCE_RELEASE_TAG_MISMATCH');
  if (
    typeof value.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit)
  )
    throw new Error('MANIFEST_SOURCE_INVALID');
  if (
    value.buildDate !== undefined &&
    (typeof value.buildDate !== 'string' || !validDate(value.buildDate))
  )
    throw new Error('MANIFEST_BUILD_DATE_INVALID');
  return {
    schemaVersion: 2,
    releaseContractVersion: SUPPORTED_RELEASE_CONTRACT_VERSION,
    version,
    releaseTag,
    channel: 'stable',
    minimumVersion,
    minimumUpdaterVersion,
    images,
    database: {
      migrationCompatibility: value.database
        .migrationCompatibility as ReleaseManifest['database']['migrationCompatibility'],
    },
    supplyChain: {
      attestationPolicy: value.supplyChain
        .attestationPolicy as ReleaseManifest['supplyChain']['attestationPolicy'],
    },
    requiresManualAction: value.requiresManualAction,
    sourceCommit: value.sourceCommit,
    ...(typeof value.buildDate === 'string' && validDate(value.buildDate)
      ? { buildDate: value.buildDate }
      : {}),
  };
}

const sensitiveAssignment =
  /\b([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY|COOKIE|AUTHORIZATION|DATABASE_URL|SMTP|PEPPER)[A-Z0-9_]*)\s*[=:]\s*([^\r\n,;]+)/gi;
const sensitiveJson =
  /(["']?(?:auth|password|token|secret|cookie|authorization|database_url|smtp_password|email_encryption_key|password_pepper|registration_key_hash_secret|updater_shared_secret)["']?\s*:\s*)["']?[^"'\s,}]+["']?/gi;
const bearer = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const terminalEscape =
  /[\u001B\u009B](?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/g;

export function sanitizeLog(value: unknown) {
  return String(value ?? '')
    .replace(terminalEscape, '')
    .replace(bearer, 'Bearer <redacted>')
    .replace(sensitiveAssignment, '$1=<redacted>')
    .replace(sensitiveJson, '$1"<redacted>"')
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r\n\u2028\u2029]+/g,
      ' ',
    )
    .slice(0, 2_000);
}

export function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('MANIFEST_UNKNOWN_FIELD');
}

function validDate(value: string) {
  return value.length <= 64 && Number.isFinite(new Date(value).getTime());
}
