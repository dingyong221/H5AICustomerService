import { createHash } from 'node:crypto';

const repository = 'dingyong221/H5AICustomerService';
const registryRepository = repository.toLowerCase();
const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const planKeys = [
  'schemaVersion',
  'repository',
  'sourceSha',
  'pathMode',
  'sourceCandidateRunId',
  'sourceCandidateAttempt',
  'sourceCiRunId',
  'sourceCiAttempt',
  'sourceManifestArtifactId',
  'sourceManifestArchiveSha256',
  'sourceManifestSha256',
  'maxArchiveBytes',
  'maxUnpackedTarBytes',
  'minimumRunnerFreeBytes',
  'images',
];
const sourceKeys = ['app', 'imageRef', 'loadTag'];
const imageKeys = [...sourceKeys, 'configDigest', 'sizeBytes', 'os', 'architecture'];
const deliveryKeys = [
  'format',
  'repository',
  'sourceSha',
  'pathMode',
  'sourceCandidateRunId',
  'sourceCiRunId',
  'sourceManifestArtifactId',
  'sourceManifestArchiveSha256',
  'sourceManifestSha256',
  'transportSha',
  'transportRunId',
  'createdAt',
  'archive',
  'images',
  'registryDigestsRetained',
  'realModelVerified',
  'provenanceAttestationVerified',
  'publicDeployment',
];
const transportPaths = new Set([
  '.github/workflows/ci.yml',
  'scripts/quality/candidate-offline-contract.mjs',
  'scripts/quality/candidate-offline-contract.test.mjs',
  'scripts/quality/export-candidate-offline.mjs',
  'scripts/operations/r1-offline-delivery-plan.json',
  'docs/operations/2026-10-17-offline-candidate-delivery.md',
]);

export const REQUIRED_APPS = Object.freeze([
  'api',
  'worker',
  'merchant-web',
  'consumer-h5',
  'ops-web',
]);

export class OfflineDeliveryError extends Error {
  constructor(code) {
    const safeCode =
      typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
        ? code
        : 'OFFLINE_CONTRACT_INVALID';
    super(safeCode);
    this.name = 'OfflineDeliveryError';
    this.code = safeCode;
  }
}

const fail = (code) => {
  throw new OfflineDeliveryError(code);
};
const positiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const digest = (value) =>
  typeof value === 'string' && sha256Pattern.test(value) && value !== `sha256:${'0'.repeat(64)}`;
const commit = (value) =>
  typeof value === 'string' && commitPattern.test(value) && value !== '0'.repeat(40);
const record = (value) =>
  value !== null &&
  typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'),
  );

function exact(value, keys, code) {
  if (
    !record(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail(code);
}

function array(value, code, length) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    (length !== undefined && value.length !== length) ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => String(index)).some(
      (key) =>
        !Object.hasOwn(value, key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'),
    )
  )
    fail(code);
}

const loadTag = (app, plan) => `h5cs-offline-${app}:${plan.sourceSha}`;

function sourceRecord(value, plan, code) {
  exact(value, sourceKeys, code);
  if (
    !REQUIRED_APPS.includes(value.app) ||
    value.imageRef !== plan.images[value.app] ||
    value.loadTag !== loadTag(value.app, plan)
  )
    fail(code);
  return Object.freeze({ app: value.app, imageRef: value.imageRef, loadTag: value.loadTag });
}

function checkedImageRecord(value, plan, code) {
  exact(value, imageKeys, code);
  const source = sourceRecord(
    { app: value.app, imageRef: value.imageRef, loadTag: value.loadTag },
    plan,
    code,
  );
  if (
    !digest(value.configDigest) ||
    !positiveSafeInteger(value.sizeBytes) ||
    value.os !== 'linux' ||
    value.architecture !== 'amd64'
  )
    fail(code);
  return Object.freeze({
    ...source,
    configDigest: value.configDigest,
    sizeBytes: value.sizeBytes,
    os: 'linux',
    architecture: 'amd64',
  });
}

function inspectIdentity(value, plan, code) {
  if (
    !record(value) ||
    !digest(value.Id) ||
    value.Os !== 'linux' ||
    value.Architecture !== 'amd64' ||
    !record(value.Config) ||
    value.Config.User !== 'node' ||
    !record(value.Config.Labels)
  )
    fail(code);
  const labels = value.Config.Labels;
  const expected = {
    'org.opencontainers.image.source': `https://github.com/${repository}`,
    'org.opencontainers.image.revision': plan.sourceSha,
    'org.opencontainers.image.h5cs.web-path-mode': plan.pathMode,
  };
  if (
    Object.entries(expected).some(
      ([key, expectedValue]) => !Object.hasOwn(labels, key) || labels[key] !== expectedValue,
    )
  )
    fail(code);
}

export function validatePlan(plan) {
  const code = 'OFFLINE_PLAN_INVALID';
  exact(plan, planKeys, code);
  if (
    plan.schemaVersion !== 1 ||
    plan.repository !== repository ||
    plan.pathMode !== 'same_domain' ||
    !commit(plan.sourceSha) ||
    !digest(plan.sourceManifestArchiveSha256) ||
    !digest(plan.sourceManifestSha256)
  )
    fail(code);
  for (const key of [
    'sourceCandidateRunId',
    'sourceCandidateAttempt',
    'sourceCiRunId',
    'sourceCiAttempt',
    'sourceManifestArtifactId',
    'maxArchiveBytes',
    'maxUnpackedTarBytes',
    'minimumRunnerFreeBytes',
  ]) {
    if (!positiveSafeInteger(plan[key])) fail(code);
  }
  if (
    plan.maxArchiveBytes > plan.maxUnpackedTarBytes ||
    !Number.isSafeInteger(
      plan.maxArchiveBytes + plan.maxUnpackedTarBytes + plan.minimumRunnerFreeBytes,
    )
  )
    fail(code);
  exact(plan.images, REQUIRED_APPS, code);
  for (const app of REQUIRED_APPS) {
    const prefix = `ghcr.io/${registryRepository}/${app}@`;
    if (
      typeof plan.images[app] !== 'string' ||
      !plan.images[app].startsWith(prefix) ||
      !digest(plan.images[app].slice(prefix.length))
    )
      fail(code);
  }
  return Object.freeze({ ...plan, images: Object.freeze({ ...plan.images }) });
}

export function parseSourceManifest(text, plan) {
  const checkedPlan = validatePlan(plan);
  const code = 'OFFLINE_SOURCE_MANIFEST_INVALID';
  if (
    typeof text !== 'string' ||
    text.length > 4096 ||
    `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}` !==
      checkedPlan.sourceManifestSha256
  )
    fail(code);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const normalized = lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (normalized.length !== REQUIRED_APPS.length) fail(code);
  const found = new Map();
  for (const line of normalized) {
    const app = REQUIRED_APPS.find((name) => checkedPlan.images[name] === line);
    if (!app || found.has(app)) fail(code);
    found.set(app, Object.freeze({ app, imageRef: line, loadTag: loadTag(app, checkedPlan) }));
  }
  return Object.freeze(REQUIRED_APPS.map((app) => found.get(app)));
}

export function validateSourceRun(run, plan, kind = 'candidate') {
  const checkedPlan = validatePlan(plan);
  const code = 'OFFLINE_SOURCE_RUN_INVALID';
  if (
    !['candidate', 'ci'].includes(kind) ||
    !record(run) ||
    !record(run.repository) ||
    !record(run.head_repository)
  )
    fail(code);
  const belongs = (value) =>
    typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
  const expectedId =
    kind === 'candidate' ? checkedPlan.sourceCandidateRunId : checkedPlan.sourceCiRunId;
  const expectedAttempt =
    kind === 'candidate' ? checkedPlan.sourceCandidateAttempt : checkedPlan.sourceCiAttempt;
  const expectedPath = `.github/workflows/${kind === 'candidate' ? 'candidate-images' : 'ci'}.yml`;
  const allowedEvents =
    kind === 'candidate' ? ['workflow_dispatch'] : ['pull_request', 'push', 'workflow_dispatch'];
  if (
    run.id !== expectedId ||
    run.run_attempt !== expectedAttempt ||
    run.head_sha !== checkedPlan.sourceSha ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.path !== expectedPath ||
    !allowedEvents.includes(run.event) ||
    !belongs(run.repository.full_name) ||
    !belongs(run.head_repository.full_name)
  )
    fail(code);
  return Object.freeze({
    id: run.id,
    run_attempt: run.run_attempt,
    head_sha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    path: run.path,
  });
}

export function imageRecord(inspectObject, source, plan) {
  const checkedPlan = validatePlan(plan);
  const code = 'OFFLINE_SOURCE_IMAGE_INVALID';
  const checkedSource = sourceRecord(source, checkedPlan, code);
  inspectIdentity(inspectObject, checkedPlan, code);
  array(inspectObject.RepoDigests, code);
  if (
    !inspectObject.RepoDigests.every((value) => typeof value === 'string') ||
    !inspectObject.RepoDigests.includes(checkedSource.imageRef) ||
    !positiveSafeInteger(inspectObject.Size)
  )
    fail(code);
  return Object.freeze({
    ...checkedSource,
    configDigest: inspectObject.Id,
    sizeBytes: inspectObject.Size,
    os: inspectObject.Os,
    architecture: inspectObject.Architecture,
  });
}

export function assertLoadedImage(inspectObject, value, plan) {
  const checkedPlan = validatePlan(plan);
  const code = 'OFFLINE_LOADED_IMAGE_INVALID';
  const checkedRecord = checkedImageRecord(value, checkedPlan, code);
  inspectIdentity(inspectObject, checkedPlan, code);
  array(inspectObject.RepoTags, code);
  if (
    inspectObject.Id !== checkedRecord.configDigest ||
    !inspectObject.RepoTags.every((tag) => typeof tag === 'string') ||
    !inspectObject.RepoTags.includes(checkedRecord.loadTag)
  )
    fail(code);
  // docker save/load preserves config identity and our reserved tag. It does
  // not promise the original registry RepoDigests will be reconstructed.
  return checkedRecord;
}

export function validateDeliveryManifest(data, plan) {
  const checkedPlan = validatePlan(plan);
  const code = 'OFFLINE_DELIVERY_MANIFEST_INVALID';
  exact(data, deliveryKeys, code);
  if (
    data.format !== 'h5cs-candidate-offline-v1' ||
    !commit(data.transportSha) ||
    !positiveSafeInteger(data.transportRunId)
  )
    fail(code);
  for (const key of [
    'repository',
    'sourceSha',
    'pathMode',
    'sourceCandidateRunId',
    'sourceCiRunId',
    'sourceManifestArtifactId',
    'sourceManifestArchiveSha256',
    'sourceManifestSha256',
  ]) {
    if (data[key] !== checkedPlan[key]) fail(code);
  }
  if (
    typeof data.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(data.createdAt) ||
    !Number.isFinite(Date.parse(data.createdAt)) ||
    new Date(data.createdAt).toISOString() !== data.createdAt
  )
    fail(code);
  for (const key of [
    'registryDigestsRetained',
    'realModelVerified',
    'provenanceAttestationVerified',
    'publicDeployment',
  ]) {
    if (data[key] !== false) fail(code);
  }
  exact(data.archive, ['filename', 'sha256', 'sizeBytes', 'unpackedTarBytes'], code);
  if (
    data.archive.filename !== 'candidate-images.tar.gz' ||
    !digest(data.archive.sha256) ||
    !positiveSafeInteger(data.archive.sizeBytes) ||
    data.archive.sizeBytes > checkedPlan.maxArchiveBytes ||
    !positiveSafeInteger(data.archive.unpackedTarBytes) ||
    data.archive.unpackedTarBytes > checkedPlan.maxUnpackedTarBytes
  )
    fail(code);
  array(data.images, code, REQUIRED_APPS.length);
  const found = new Map();
  const configs = new Set();
  for (const image of data.images) {
    const checked = checkedImageRecord(image, checkedPlan, code);
    if (found.has(checked.app) || configs.has(checked.configDigest)) fail(code);
    found.set(checked.app, checked);
    configs.add(checked.configDigest);
  }
  return Object.freeze({
    ...data,
    archive: Object.freeze({ ...data.archive }),
    images: Object.freeze(REQUIRED_APPS.map((app) => found.get(app))),
  });
}

export function assertTransportOnlyPaths(paths) {
  const code = 'OFFLINE_TRANSPORT_PATHS_INVALID';
  array(paths, code);
  if (
    paths.length === 0 ||
    paths.length > transportPaths.size ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => typeof path !== 'string' || !transportPaths.has(path))
  )
    fail(code);
  return Object.freeze([...paths]);
}
