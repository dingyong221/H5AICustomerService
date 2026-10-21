import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const SOURCE_SHA = '43a70d4591913214b82c79a22b1a7eceed6ca67c';
export const BASE_SHA = 'fcf4099a3662290410be0ed814b7f75720b94de4';
export const SOURCE_CI_RUN_ID = 39545754179;
export const SOURCE_CI_ATTEMPT = 1;
export const RELEASE_FROZEN = true;
export const BRANCH = 'codex/merchant-guided-workflow-delivery';
export const APPLICATION_PATHS = Object.freeze([
  "apps/merchant-web/app/[merchantId]/drafts/new/page.tsx",
  "apps/merchant-web/app/[merchantId]/drafts/page.tsx",
  "apps/merchant-web/app/[merchantId]/knowledge/[assistantId]/materials/apply/route.ts",
  "apps/merchant-web/app/[merchantId]/page.tsx",
  "apps/merchant-web/app/[merchantId]/preview/[assistantId]/page.tsx",
  "apps/merchant-web/app/[merchantId]/preview/page.tsx",
  "apps/merchant-web/app/account/merchant-return-path.test.ts",
  "apps/merchant-web/app/account/merchant-return-path.ts",
  "apps/merchant-web/app/assistant-collection.tsx",
  "apps/merchant-web/app/assistant-view.test.tsx",
  "apps/merchant-web/app/assistant-view.tsx",
  "apps/merchant-web/app/assistant-workflow.tsx",
  "apps/merchant-web/app/help/help-center.tsx",
  "apps/merchant-web/app/help/manual-publishing.test.ts",
  "apps/merchant-web/app/help/manual.ts",
  "apps/merchant-web/app/improvements/improvement-actions.ts",
  "apps/merchant-web/app/knowledge/material-manager.test.tsx",
  "apps/merchant-web/app/knowledge/material-manager.tsx",
  "apps/merchant-web/app/layout.tsx",
  "apps/merchant-web/app/navigation.test.tsx",
  "apps/merchant-web/app/navigation.tsx",
  "apps/merchant-web/app/styles.css",
  "apps/merchant-web/app/tenant-paths.ts",
  "apps/merchant-web/app/workspace/create-assistant-form.tsx",
  "apps/merchant-web/app/workspace/edit-draft-form.tsx",
  "apps/merchant-web/app/workspace/guided-draft-forms.test.tsx",
  "apps/merchant-web/app/workspace/knowledge-actions.ts",
  "apps/merchant-web/app/workspace/publish-actions.ts",
  "apps/merchant-web/app/workspace/use-unsaved-form.test.ts",
  "apps/merchant-web/app/workspace/use-unsaved-form.ts",
  "apps/merchant-web/app/workspace/workspace-actions.ts",
  "apps/merchant-web/app/writing/draft-fields.tsx",
  "tests/e2e/merchant-to-consumer.spec.ts"
]);
export const TRANSPORT_PATHS = Object.freeze([
  '.github/workflows/ci.yml',
  'scripts/quality/export-merchant-integration-offline.mjs',
  'scripts/quality/export-merchant-integration-offline.test.mjs',
]);
export const CI_JOBS = Object.freeze([
  'Quality and build',
  'Real MySQL merchant-to-consumer flow',
  'Browser operator-to-consumer flow',
  'Build five release container targets',
]);
const REPOSITORY = 'dingyong221/H5AICustomerService',
  CI_TAG = 'h5cs-merchant-web:ci';
export const LOAD_TAG = `h5cs-offline-merchant-web:${SOURCE_SHA}`;
const MAX_TAR = 2 * 1024 ** 3,
  MAX_GZIP = 1024 ** 3,
  RESERVE = 2 * 1024 ** 3;
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sha = (value) =>
  typeof value === 'string' &&
  /^sha256:[0-9a-f]{64}$/u.test(value) &&
  value !== `sha256:${'0'.repeat(64)}`;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export class MerchantDeliveryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const need = (condition, code) => {
  if (!condition) throw new MerchantDeliveryError(code);
};

export function exactPaths(actual, expected) {
  need(
    Array.isArray(actual) &&
      actual.length === expected.length &&
      new Set(actual).size === actual.length &&
      actual.every((path) => expected.includes(path)),
    'SOURCE_OR_TRANSPORT_PATHS_INVALID',
  );
  return [...actual].sort();
}

export function validateSourceCompatibility(actual) {
  const paths = exactPaths(actual, APPLICATION_PATHS);
  // This source is merchant UI/routing/actions/help plus browser tests only.
  // No shared DB/schema, API, Worker, other web runtime or dependency change.
  exactPaths(paths.filter((path) => !path.startsWith('apps/merchant-web/')),
    APPLICATION_PATHS.filter((path) => !path.startsWith('apps/merchant-web/')));
  need(paths.every((path) => path.startsWith('apps/merchant-web/') ||
    path === 'tests/e2e/merchant-to-consumer.spec.ts'), 'SOURCE_RUNTIME_SCOPE_INVALID');
  return paths;
}
export function validateFrozenRelease(value = {
  frozen: RELEASE_FROZEN, sourceSha: SOURCE_SHA, runId: SOURCE_CI_RUN_ID,
  attempt: SOURCE_CI_ATTEMPT, paths: APPLICATION_PATHS,
}) {
  need(value.frozen === true && /^[0-9a-f]{40}$/u.test(value.sourceSha ?? '') &&
    value.sourceSha !== BASE_SHA && Number.isSafeInteger(value.runId) && value.runId > 0 &&
    Number.isSafeInteger(value.attempt) && value.attempt > 0 &&
    Array.isArray(value.paths) && value.paths.length > 0, 'FINAL_RELEASE_IDENTITY_NOT_FROZEN');
  return true;
}

export function childEnvironment(environment) {
  return Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'DOCKER_CONFIG', 'TMPDIR', 'TEMP', 'TMP']
      .filter((key) => typeof environment[key] === 'string')
      .map((key) => [key, environment[key]]),
  );
}
export function validateContext(e, platform = process.platform) {
  need(
    platform === 'linux' &&
      e.CI === 'true' &&
      e.RUNNER_ENVIRONMENT === 'github-hosted' &&
      e.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      e.GITHUB_REF_NAME === BRANCH &&
      e.GITHUB_REPOSITORY === REPOSITORY &&
      /^[0-9a-f]{40}$/u.test(e.GITHUB_SHA ?? '') &&
      /^[1-9][0-9]{0,15}$/u.test(e.GITHUB_RUN_ID ?? '') &&
      Number.isSafeInteger(Number(e.GITHUB_RUN_ID)) &&
      isAbsolute(e.RUNNER_TEMP ?? '') &&
      isAbsolute(e.GITHUB_OUTPUT ?? '') &&
      !['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].some((key) =>
        Boolean(e[key]),
      ),
    'DEDICATED_RUNNER_REQUIRED',
  );
}
export function validateCi(run, jobs) {
  need(
    record(run) &&
      run.head_sha === SOURCE_SHA &&
      run.path === '.github/workflows/ci.yml' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      ['pull_request', 'push', 'workflow_dispatch'].includes(run.event) &&
      run.repository?.full_name?.toLowerCase() === REPOSITORY.toLowerCase() &&
      run.head_repository?.full_name?.toLowerCase() === REPOSITORY.toLowerCase() &&
      run.id === SOURCE_CI_RUN_ID &&
      run.run_attempt === SOURCE_CI_ATTEMPT,
    'SOURCE_CI_NOT_VERIFIED',
  );
  need(
    jobs?.total_count === CI_JOBS.length &&
      Array.isArray(jobs.jobs) &&
      jobs.jobs.length === CI_JOBS.length,
    'SOURCE_CI_JOB_SET_INVALID',
  );
  const found = new Set();
  for (const job of jobs.jobs) {
    need(
      CI_JOBS.includes(job.name) &&
        !found.has(job.name) &&
        job.head_sha === SOURCE_SHA &&
        job.status === 'completed' &&
        job.conclusion === 'success',
      'SOURCE_CI_JOB_NOT_SUCCESSFUL',
    );
    found.add(job.name);
  }
  return {
    runId: run.id,
    attempt: run.run_attempt,
    headSha: SOURCE_SHA,
    conclusion: 'success',
    jobs: [...found].sort(),
  };
}
export function validateImage(image) {
  need(
    record(image) &&
      sha(image.Id) &&
      image.Os === 'linux' &&
      image.Architecture === 'amd64' &&
      image.Config?.User === 'node' &&
      Number.isSafeInteger(image.Size) &&
      image.Size > 0 &&
      image.RootFS?.Type === 'layers' &&
      Array.isArray(image.RootFS.Layers) &&
      image.RootFS.Layers.length > 0 &&
      image.RootFS.Layers.every(sha),
    'IMAGE_IDENTITY_INVALID',
  );
  const expected = {
    'org.opencontainers.image.source': `https://github.com/${REPOSITORY}`,
    'org.opencontainers.image.revision': SOURCE_SHA,
    'org.opencontainers.image.h5cs.web-path-mode': 'same_domain',
  };
  need(
    Object.entries(expected).every(([key, value]) => image.Config.Labels?.[key] === value),
    'IMAGE_SOURCE_LABELS_INVALID',
  );
  return {
    runtimeImageId: image.Id,
    sizeBytes: image.Size,
    os: 'linux',
    architecture: 'amd64',
    user: 'node',
    webPathMode: 'same_domain',
    rootFsDiffIds: [...image.RootFS.Layers],
  };
}
export function validateOwnedReferences(image, expectedTags) {
  need(
    Array.isArray(image.RepoTags) &&
      image.RepoTags.length === expectedTags.length &&
      new Set(image.RepoTags).size === expectedTags.length &&
      image.RepoTags.every((tag) => expectedTags.includes(tag)) &&
      Array.isArray(image.RepoDigests) &&
      image.RepoDigests.length === 0,
    'UNKNOWN_IMAGE_REFERENCE',
  );
}
export function boundedStream(maximum, code = 'ARCHIVE_LIMIT_EXCEEDED') {
  need(Number.isSafeInteger(maximum) && maximum > 0, 'INVALID_STREAM_LIMIT');
  let bytes = 0;
  return {
    stream: new Transform({
      transform(chunk, _encoding, done) {
        if (chunk.length > maximum - bytes) return done(new MerchantDeliveryError(code));
        bytes += chunk.length;
        done(null, chunk);
      },
    }),
    count: () => bytes,
  };
}

const graphPython = String.raw`
import hashlib,json,sys,tarfile
p=sys.argv[1]; entries={}; js={}; total=0
with tarfile.open(p,'r:') as tf:
 for m in tf:
  n=m.name
  if n in entries or n.startswith('/') or '..' in n.split('/') or chr(92) in n or any(ord(c)<32 for c in n): raise RuntimeError('bad entry')
  if m.isdir(): continue
  if not m.isfile() or m.size<0: raise RuntimeError('not regular')
  total+=m.size
  if total>2147483648 or len(entries)>=128: raise RuntimeError('limit')
  h=hashlib.sha256(); chunks=[]; remaining=m.size
  f=tf.extractfile(m)
  while remaining:
   b=f.read(min(1048576,remaining))
   if not b: raise RuntimeError('short')
   remaining-=len(b); h.update(b)
   if m.size<=8388608: chunks.append(b)
  d=h.hexdigest()
  if n.startswith('blobs/sha256/') and n.split('/')[-1]!=d: raise RuntimeError('blob hash')
  entries[n]={'sha256':'sha256:'+d,'sizeBytes':m.size}
  if chunks:
   b=b''.join(chunks)
   if b.lstrip()[:1] in (b'{',b'['):
    try: js[n]=json.loads(b)
    except (ValueError,UnicodeError): pass
print(json.dumps({'entries':entries,'json':js},separators=(',',':')))
`;

export function validateArchiveGraph(inventory, runtime) {
  need(record(inventory?.entries) && record(inventory?.json), 'ARCHIVE_GRAPH_INVALID');
  const legacy = inventory.json['manifest.json'];
  need(
    Array.isArray(legacy) && legacy.length === 1 && record(legacy[0]),
    'ARCHIVE_LEGACY_MANIFEST_INVALID',
  );
  const item = legacy[0],
    config = inventory.json[item.Config],
    configEntry = inventory.entries[item.Config];
  need(
    Array.isArray(item.RepoTags) &&
      item.RepoTags.length === 1 &&
      item.RepoTags[0] === LOAD_TAG &&
      Array.isArray(item.Layers) &&
      item.Layers.length === runtime.rootFsDiffIds.length &&
      item.Layers.every((path) => record(inventory.entries[path])),
    'ARCHIVE_TAG_OR_LAYERS_INVALID',
  );
  need(
    record(config) &&
      sha(configEntry?.sha256) &&
      config.os === 'linux' &&
      config.architecture === 'amd64' &&
      config.config?.User === 'node' &&
      JSON.stringify(config.rootfs?.diff_ids) === JSON.stringify(runtime.rootFsDiffIds),
    'ARCHIVE_CONFIG_INVALID',
  );
  need(
    config.config?.Labels?.['org.opencontainers.image.source'] ===
      `https://github.com/${REPOSITORY}` &&
      config.config?.Labels?.['org.opencontainers.image.revision'] === SOURCE_SHA &&
      config.config?.Labels?.['org.opencontainers.image.h5cs.web-path-mode'] === 'same_domain',
    'ARCHIVE_CONFIG_LABELS_INVALID',
  );
  const configDigest = configEntry.sha256,
    manifests = [];
  for (const [path, data] of Object.entries(inventory.json)) {
    if (
      data?.schemaVersion === 2 &&
      data.config?.digest === configDigest &&
      Array.isArray(data.layers)
    ) {
      need(
        sha(inventory.entries[path]?.sha256) &&
          data.layers.length === runtime.rootFsDiffIds.length &&
          data.layers.every(
            (layer) =>
              sha(layer.digest) &&
              Object.values(inventory.entries).some(
                (entry) => entry.sha256 === layer.digest && entry.sizeBytes === layer.size,
              ),
          ),
        'OCI_MANIFEST_LAYER_INVALID',
      );
      manifests.push(inventory.entries[path].sha256);
    }
  }
  need(
    runtime.runtimeImageId === configDigest || manifests.includes(runtime.runtimeImageId),
    'RUNTIME_NOT_BOUND_TO_ARCHIVE',
  );
  return {
    configDigest,
    legacyManifestSha256: inventory.entries['manifest.json'].sha256,
    rootIndexSha256: inventory.entries['index.json']?.sha256 ?? null,
    manifestDigests: manifests.sort(),
    rootFsDiffIds: runtime.rootFsDiffIds,
    allBlobFileHashesVerified: true,
    configAndRuntimeBound: true,
    rootIndexReachabilityVerified: false,
  };
}

function command(
  program,
  args,
  e,
  { allowMissing = false, timeout = 300000, limit = 16 * 1024 ** 2 } = {},
) {
  const result = spawnSync(program, args, {
    cwd: process.cwd(),
    env: childEnvironment(e),
    encoding: 'utf8',
    maxBuffer: limit,
    timeout,
    shell: false,
  });
  need(
    !result.error && (result.status === 0 || (allowMissing && result.status === 1)),
    'LOCAL_TOOL_FAILED',
  );
  return { status: result.status, stdout: result.stdout ?? '' };
}
const docker = (args, e, options) => command('docker', args, e, options);
const git = (args, e) => command('git', args, e).stdout.trim();
function inspect(ref, e) {
  const list = JSON.parse(docker(['image', 'inspect', ref], e).stdout);
  need(Array.isArray(list) && list.length === 1, 'INSPECT_RESULT_INVALID');
  return list[0];
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}
const proofPath = (e, suffix) => join(e.RUNNER_TEMP, `h5cs-merchant-integration-${suffix}.json`);
async function writeProof(e, suffix, data) {
  await writeFile(proofPath(e, suffix), JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 });
}
async function proof(e, suffix) {
  const path = proofPath(e, suffix),
    info = await lstat(path);
  need(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.size < 1024 * 1024 &&
      dirname(await realpath(path)) === (await realpath(e.RUNNER_TEMP)),
    'PROOF_FILE_INVALID',
  );
  const value = JSON.parse(await readFile(path, 'utf8'));
  need(
    value.sourceSha === SOURCE_SHA &&
      value.compatibleBaseSha === BASE_SHA &&
      value.merchantRuntimeOnlyCompatibleWithBase === true &&
      value.transportSha === e.GITHUB_SHA &&
      value.transportRunId === Number(e.GITHUB_RUN_ID) &&
      value.helperSha256 === (await fileHash(fileURLToPath(import.meta.url))),
    'PROOF_CONTEXT_DRIFT',
  );
  validateSourceCompatibility(value.sourceChangedPaths);
  exactPaths(value.transportChangedPaths, TRANSPORT_PATHS);
  return value;
}
async function api(path, e) {
  need(
    typeof e.GITHUB_TOKEN === 'string' && Boolean(e.GITHUB_TOKEN),
    'READ_ONLY_API_TOKEN_REQUIRED',
  );
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: {
      Authorization: `Bearer ${e.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(25000),
  });
  need(response.ok && response.body, 'SOURCE_API_READ_FAILED');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    need(size <= 2 * 1024 ** 2, 'SOURCE_API_RESPONSE_LIMIT');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function prepare(e) {
  need(git(['rev-parse', 'HEAD'], e) === e.GITHUB_SHA, 'TRANSPORT_CHECKOUT_DRIFT');
  const paths = exactPaths(
    git(['diff', '--name-only', SOURCE_SHA, 'HEAD', '--'], e).split(/\r?\n/u).filter(Boolean),
    TRANSPORT_PATHS,
  );
  const sourcePaths = validateSourceCompatibility(
    git(['diff', '--name-only', BASE_SHA, SOURCE_SHA, '--'], e).split(/\r?\n/u).filter(Boolean),
  );
  need(
    docker(['context', 'show'], e).stdout.trim() === 'default' &&
      docker(
        ['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}'],
        e,
      ).stdout.trim() === 'unix:///var/run/docker.sock',
    'LOCAL_DEFAULT_DOCKER_REQUIRED',
  );
  for (const ref of [CI_TAG, LOAD_TAG])
    need(
      docker(['image', 'inspect', ref], e, { allowMissing: true }).status === 1,
      'PREEXISTING_IMAGE_REFERENCE',
    );
  const baselineIds = [
    ...new Set(
      docker(['image', 'ls', '--quiet', '--no-trunc'], e)
        .stdout.trim()
        .split(/\r?\n/u)
        .filter(Boolean),
    ),
  ];
  await writeProof(e, 'prepared', {
    sourceSha: SOURCE_SHA,
    compatibleBaseSha: BASE_SHA,
    sourceChangedPaths: sourcePaths,
    merchantRuntimeOnlyCompatibleWithBase: true,
    transportChangedPaths: paths,
    transportSha: e.GITHUB_SHA,
    transportRunId: Number(e.GITHUB_RUN_ID),
    helperSha256: await fileHash(fileURLToPath(import.meta.url)),
    baselineIds,
  });
  return {
    code: 'TRANSPORT_ONLY_AND_MERCHANT_COMPATIBILITY_CHECKED',
    sourceSha: SOURCE_SHA,
    paths: paths.length,
    sourcePaths: sourcePaths.length,
  };
}
async function verifySource(e) {
  const prepared = await proof(e, 'prepared');
  need(git(['rev-parse', 'HEAD'], e) === SOURCE_SHA, 'SOURCE_CHECKOUT_DRIFT');
  validateSourceCompatibility(
    git(['diff', '--name-only', BASE_SHA, 'HEAD', '--'], e).split(/\r?\n/u).filter(Boolean),
  );
  const run = await api(`/actions/runs/${SOURCE_CI_RUN_ID}`, e);
  const sourceCi = validateCi(
    run,
    await api(
      `/actions/runs/${SOURCE_CI_RUN_ID}/attempts/${SOURCE_CI_ATTEMPT}/jobs?per_page=100`,
      e,
    ),
  );
  await writeProof(e, 'verified', { ...prepared, sourceCi });
  return { code: 'EXACT_SOURCE_CI_VERIFIED', sourceSha: SOURCE_SHA, sourceCi };
}
async function saveArchive(path, e) {
  const child = spawn('docker', ['image', 'save', LOAD_TAG], {
    env: childEnvironment(e),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const closed = new Promise((resolveClose) => {
    child.once('error', () => resolveClose(false));
    child.once('close', (code, signal) => resolveClose(code === 0 && signal === null));
  });
  let errors = 0;
  child.stderr.on('data', (chunk) => {
    errors += chunk.length;
    if (errors > 65536) child.kill('SIGKILL');
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 300000),
    bound = boundedStream(MAX_TAR);
  try {
    await pipeline(
      child.stdout,
      bound.stream,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    );
    need(await closed, 'SAVE_CHILD_FAILED');
    return bound.count();
  } catch (error) {
    child.kill('SIGKILL');
    await closed;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function exportArchive(e) {
  const verified = await proof(e, 'verified');
  need(git(['rev-parse', 'HEAD'], e) === SOURCE_SHA, 'SOURCE_CHECKOUT_DRIFT');
  const builtObject = inspect(CI_TAG, e),
    image = validateImage(builtObject);
  validateOwnedReferences(builtObject, [CI_TAG]);
  need(!verified.baselineIds.includes(image.runtimeImageId), 'PREEXISTING_IMAGE_CONFIG');
  need(
    docker(
      ['container', 'ls', '--all', '--quiet', '--filter', `ancestor=${image.runtimeImageId}`],
      e,
    ).stdout.trim() === '',
    'IMAGE_IN_USE',
  );
  need(
    docker(['image', 'inspect', LOAD_TAG], e, { allowMissing: true }).status === 1,
    'PREEXISTING_LOAD_TAG',
  );
  docker(['tag', CI_TAG, LOAD_TAG], e);
  const temp = await realpath(e.RUNNER_TEMP),
    disk = await statfs(temp, { bigint: true });
  need(
    disk.bavail * disk.bsize >= BigInt(MAX_TAR + MAX_GZIP + RESERVE + 64 * 1024 ** 2),
    'RUNNER_EXPORT_CAPACITY_REQUIRED',
  );
  const directory = await mkdtemp(join(temp, 'h5cs-merchant-offline-')),
    tar = join(directory, 'merchant-image.tar'),
    archive = join(directory, 'merchant-images.tar.gz');
  const unpackedTarBytes = await saveArchive(tar, e);
  const inventory = JSON.parse(command('python3', ['-I', '-c', graphPython, tar], e).stdout);
  const archiveGraph = validateArchiveGraph(inventory, image);
  const bounded = boundedStream(MAX_GZIP, 'COMPRESSED_ARCHIVE_LIMIT_EXCEEDED');
  await pipeline(
    createReadStream(tar),
    createGzip({ level: 1 }),
    bounded.stream,
    createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
  );
  const info = await lstat(archive),
    archiveSha256 = await fileHash(archive);
  need(
    info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size === bounded.count(),
    'GENERATED_ARCHIVE_INVALID',
  );
  need(
    (await realpath(tar)) === tar && dirname(tar) === directory,
    'GENERATED_TAR_IDENTITY_CHANGED',
  );
  await unlink(tar);
  for (const ref of [CI_TAG, LOAD_TAG]) {
    const object = inspect(ref, e),
      actual = validateImage(object);
    validateOwnedReferences(object, ref === CI_TAG ? [CI_TAG, LOAD_TAG] : [LOAD_TAG]);
    need(
      docker(
        ['container', 'ls', '--all', '--quiet', '--filter', `ancestor=${image.runtimeImageId}`],
        e,
      ).stdout.trim() === '',
      'IMAGE_IN_USE',
    );
    need(
      actual.runtimeImageId === image.runtimeImageId &&
        JSON.stringify(actual.rootFsDiffIds) === JSON.stringify(image.rootFsDiffIds),
      'OWNED_IMAGE_DRIFT',
    );
    docker(['image', 'rm', ref], e);
  }
  need(
    docker(['image', 'inspect', image.runtimeImageId], e, { allowMissing: true }).status === 1,
    'ROUNDTRIP_IMAGE_RETAINED',
  );
  docker(['image', 'load', '--input', archive], e);
  const loadedObject = inspect(LOAD_TAG, e),
    loaded = validateImage(loadedObject);
  validateOwnedReferences(loadedObject, [LOAD_TAG]);
  need(
    Array.isArray(loadedObject.RepoTags) &&
      loadedObject.RepoTags.includes(LOAD_TAG) &&
      JSON.stringify(loaded.rootFsDiffIds) === JSON.stringify(image.rootFsDiffIds) &&
      (loaded.runtimeImageId === archiveGraph.configDigest ||
        archiveGraph.manifestDigests.includes(loaded.runtimeImageId)),
    'ROUNDTRIP_IDENTITY_NOT_PROVEN',
  );
  const delivery = {
    format: 'h5cs-merchant-runtime-offline-v2',
    sourceSha: SOURCE_SHA,
    compatibleBaseSha: BASE_SHA,
    merchantRuntimeOnlyCompatibleWithBase: true,
    exactSourcePaths: verified.sourceChangedPaths,
    sourceCiRunId: verified.sourceCi.runId,
    sourceCiAttempt: verified.sourceCi.attempt,
    sourceCiJobs: verified.sourceCi.jobs,
    transportSha: e.GITHUB_SHA,
    transportRunId: Number(e.GITHUB_RUN_ID),
    helperSha256: verified.helperSha256,
    createdAt: new Date().toISOString(),
    app: 'merchant-web',
    imageId: loaded.runtimeImageId,
    configDigest: archiveGraph.configDigest,
    loadTag: LOAD_TAG,
    webPathMode: 'same_domain',
    sameDomainTag: 'same_domain',
    image: { ...loaded, configDigest: archiveGraph.configDigest, loadTag: LOAD_TAG },
    archiveGraph,
    archive: {
      filename: 'merchant-images.tar.gz',
      sha256: archiveSha256,
      sizeBytes: info.size,
      unpackedTarBytes,
    },
    dockerRoundtripVerified: true,
    registryDigestsRetained: false,
    realModelVerified: false,
    provenanceAttestationVerified: false,
    publicDeployment: false,
  };
  await writeFile(
    join(directory, 'merchant-delivery.json'),
    JSON.stringify(delivery, null, 2) + '\n',
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  need(dirname(directory) === temp && !/[\r\n]/u.test(directory), 'OUTPUT_DIRECTORY_INVALID');
  await appendFile(e.GITHUB_OUTPUT, `artifact_directory=${directory}\n`);
  return {
    code: 'SINGLE_MERCHANT_OFFLINE_ROUNDTRIP_PASSED',
    sourceSha: SOURCE_SHA,
    configDigest: archiveGraph.configDigest,
    archiveSha256,
    sizeBytes: info.size,
    unpackedTarBytes,
    publicDeployment: false,
  };
}
export async function run(e = process.env, args = process.argv.slice(2)) {
  let phase = 'context';
  try {
    validateContext(e);
    validateFrozenRelease();
    need(
      args.length === 1 && ['--prepare', '--verify-source', '--export'].includes(args[0]),
      'EXPLICIT_PHASE_REQUIRED',
    );
    phase = args[0].slice(2);
    const value =
      args[0] === '--prepare'
        ? await prepare(e)
        : args[0] === '--verify-source'
          ? await verifySource(e)
          : await exportArchive(e);
    process.stdout.write(JSON.stringify(value) + '\n');
    return true;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        code: error instanceof MerchantDeliveryError ? error.code : 'UNVERIFIED_TRANSPORT_RESULT',
        phase,
        publicDeployment: false,
        automaticRetry: false,
      }) + '\n',
    );
    return false;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  !(await run())
)
  process.exitCode = 1;
