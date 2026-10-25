import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';

import { boundedArchiveStream, requiredExportFreeBytes } from './export-candidate-offline.mjs';

import {
  OfflineDeliveryError,
  REQUIRED_APPS,
  assertLoadedImage,
  assertTransportOnlyPaths,
  imageRecord,
  parseSourceManifest,
  validateDeliveryManifest,
  validatePlan,
  validateSourceRun,
} from './candidate-offline-contract.mjs';

const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const manifestText = (images) => `${Object.values(images).sort().join('\n')}\n`;
const plan = () => {
  const images = Object.fromEntries(
    REQUIRED_APPS.map((app) => [
      app,
      `ghcr.io/dingyong221/h5aicustomerservice/${app}@${hash(app)}`,
    ]),
  );
  return {
    schemaVersion: 1,
    repository: 'dingyong221/H5AICustomerService',
    sourceSha: 'a'.repeat(40),
    pathMode: 'same_domain',
    sourceCandidateRunId: 101,
    sourceCandidateAttempt: 1,
    sourceCiRunId: 102,
    sourceCiAttempt: 1,
    sourceManifestArtifactId: 103,
    sourceManifestArchiveSha256: hash('source-zip'),
    sourceManifestSha256: hash(manifestText(images)),
    maxArchiveBytes: 536_870_912,
    maxUnpackedTarBytes: 2_147_483_648,
    minimumRunnerFreeBytes: 2_147_483_648,
    images,
  };
};
const source = (p, app = 'api') => ({
  app,
  imageRef: p.images[app],
  loadTag: `h5cs-offline-${app}:${p.sourceSha}`,
});
const inspect = (p, app = 'api') => ({
  Id: hash(`config-${app}`),
  Os: 'linux',
  Architecture: 'amd64',
  Size: 1_000_000 + REQUIRED_APPS.indexOf(app),
  RepoDigests: [p.images[app]],
  RepoTags: [`h5cs-offline-${app}:${p.sourceSha}`],
  Config: {
    User: 'node',
    Labels: {
      'org.opencontainers.image.source': `https://github.com/${p.repository}`,
      'org.opencontainers.image.revision': p.sourceSha,
      'org.opencontainers.image.h5cs.web-path-mode': p.pathMode,
    },
    Env: ['UNRELATED_PRIVATE_VALUE=sentinel-never-returned'],
  },
});
const run = (p, kind = 'candidate') => ({
  id: kind === 'candidate' ? p.sourceCandidateRunId : p.sourceCiRunId,
  run_attempt: kind === 'candidate' ? p.sourceCandidateAttempt : p.sourceCiAttempt,
  head_sha: p.sourceSha,
  status: 'completed',
  conclusion: 'success',
  event: kind === 'candidate' ? 'workflow_dispatch' : 'pull_request',
  path: `.github/workflows/${kind === 'candidate' ? 'candidate-images' : 'ci'}.yml`,
  repository: { full_name: p.repository },
  head_repository: { full_name: p.repository },
  unrelated: 'sentinel-never-returned',
});
const delivery = (p) => ({
  format: 'h5cs-candidate-offline-v1',
  repository: p.repository,
  sourceSha: p.sourceSha,
  pathMode: p.pathMode,
  sourceCandidateRunId: p.sourceCandidateRunId,
  sourceCiRunId: p.sourceCiRunId,
  sourceManifestArtifactId: p.sourceManifestArtifactId,
  sourceManifestArchiveSha256: p.sourceManifestArchiveSha256,
  sourceManifestSha256: p.sourceManifestSha256,
  transportSha: 'b'.repeat(40),
  transportRunId: 104,
  createdAt: '2026-10-20T12:34:56.789Z',
  archive: {
    filename: 'candidate-images.tar.gz',
    sha256: hash('transport-gzip'),
    sizeBytes: 10_000,
    unpackedTarBytes: 20_000,
  },
  images: REQUIRED_APPS.map((app) => imageRecord(inspect(p, app), source(p, app), p)),
  registryDigestsRetained: false,
  realModelVerified: false,
  provenanceAttestationVerified: false,
  publicDeployment: false,
});
const expectCode = (action, code) =>
  assert.throws(action, (error) => {
    assert.ok(error instanceof OfflineDeliveryError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.doesNotMatch(error.message, /sentinel|https?:|mysql:|secret/iu);
    return true;
  });
const changed = (value, mutate) => {
  const copy = structuredClone(value);
  mutate(copy);
  return copy;
};

test('export capacity reserves bounded tar and gzip once rather than double-counting virtual image layers', () => {
  const p = plan();
  assert.equal(
    requiredExportFreeBytes(p),
    BigInt(p.maxUnpackedTarBytes) +
      BigInt(p.maxArchiveBytes) +
      BigInt(p.minimumRunnerFreeBytes) +
      67_108_864n,
  );
  expectCode(() => requiredExportFreeBytes({ ...p, maxArchiveBytes: 0 }), 'OFFLINE_PLAN_INVALID');
});

test('tar stream writes exactly the configured byte bound without Docker or files', async () => {
  const bounded = boundedArchiveStream(7);
  const accepted = [];
  await pipeline(
    Readable.from([Buffer.from('abc'), Buffer.from('defg')]),
    bounded.stream,
    new Writable({
      write(chunk, _encoding, callback) {
        accepted.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(Buffer.concat(accepted).toString('utf8'), 'abcdefg');
  assert.equal(bounded.writtenBytes(), 7);
});

test('tar stream rejects an oversized first chunk or cumulative bytes before forwarding excess', async () => {
  for (const chunks of [[Buffer.from('abcdef')], [Buffer.from('abc'), Buffer.from('def')]]) {
    const bounded = boundedArchiveStream(5);
    let forwarded = 0;
    await assert.rejects(
      pipeline(
        Readable.from(chunks),
        bounded.stream,
        new Writable({
          write(chunk, _encoding, callback) {
            forwarded += chunk.length;
            callback();
          },
        }),
      ),
      (error) => error instanceof OfflineDeliveryError && error.code === 'OVERSIZED_DOCKER_ARCHIVE',
    );
    assert.ok(forwarded <= 3);
    assert.ok(bounded.writtenBytes() <= 3);
  }
});

test('tar stream refuses invalid bounds using a static error code', () => {
  for (const maximum of [0, -1, 1.5, '5', null, NaN, Number.MAX_SAFE_INTEGER + 1])
    expectCode(() => boundedArchiveStream(maximum), 'INVALID_ARCHIVE_STREAM_BOUND');
});

const exporterPath = fileURLToPath(new URL('./export-candidate-offline.mjs', import.meta.url));
const exporterRoot = fileURLToPath(new URL('../../', import.meta.url));
const simulatedToken = ['gh', 'p', '_', 'offlinecontext', 'x'.repeat(20)].join('');
const simulatedModelKey = ['s', 'k', '-', 'offlinecontext', 'y'.repeat(20)].join('');
const requiredContextKeys = [
  'CI',
  'RUNNER_ENVIRONMENT',
  'GITHUB_EVENT_NAME',
  'GITHUB_REF_NAME',
  'GITHUB_REPOSITORY',
  'GITHUB_SHA',
  'GITHUB_RUN_ID',
  'GITHUB_TOKEN',
  'RUNNER_TEMP',
  'GITHUB_OUTPUT',
];
const dockerContextKeys = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
];

// The child preloader denies side effects before the real CLI is imported. A
// context-guard regression therefore cannot start Docker, contact a network or
// write a file while this offline negative test is running. It creates no files.
const noEffectsPreload = `
  import fs from 'node:fs';
  import fsPromises from 'node:fs/promises';
  import childProcess from 'node:child_process';
  import http from 'node:http';
  import https from 'node:https';
  import net from 'node:net';
  import tls from 'node:tls';
  import { syncBuiltinESMExports } from 'node:module';
  const deny = () => {
    process.stderr.write('OFFLINE_TEST_FORBIDDEN_SIDE_EFFECT\\n');
    process.exit(86);
  };
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = deny;
  for (const key of ['appendFile', 'writeFile', 'mkdtemp', 'mkdir', 'unlink', 'rm', 'rmdir', 'rename', 'copyFile', 'cp', 'link', 'symlink', 'truncate', 'chmod', 'chown', 'utimes']) {
    if (typeof fs[key] === 'function') fs[key] = deny;
    if (typeof fs[key + 'Sync'] === 'function') fs[key + 'Sync'] = deny;
    if (typeof fsPromises[key] === 'function') fsPromises[key] = deny;
  }
  fs.createWriteStream = deny;
  http.request = http.get = https.request = https.get = deny;
  net.connect = net.createConnection = net.Socket.prototype.connect = deny;
  tls.connect = deny;
  globalThis.fetch = deny;
  syncBuiltinESMExports();
`;
const noEffectsImport = `data:text/javascript,${encodeURIComponent(noEffectsPreload)}`;

function contextEnvironment() {
  // This is an allowlist, not a copy of process.env. No ambient token, Docker
  // setting, HOME, PATH, Node option or credential location enters the child.
  const windowsRuntime = Object.fromEntries(
    ['SystemRoot', 'WINDIR']
      .filter((key) => typeof process.env[key] === 'string')
      .map((key) => [key, process.env[key]]),
  );
  return {
    ...windowsRuntime,
    NODE_NO_WARNINGS: '1',
    PATH: '',
    CI: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_NAME: 'codex/offline-one-assistant-context',
    GITHUB_REPOSITORY: 'dingyong221/H5AICustomerService',
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_RUN_ID: '104',
    GITHUB_TOKEN: simulatedToken,
    RUNNER_TEMP: join(exporterRoot, 'offline-context-must-not-be-created'),
    GITHUB_OUTPUT: join(exporterRoot, 'offline-output-must-not-be-written'),
  };
}

function expectContextRefusal(args, environment, privateValues = []) {
  // Every fixture is invalid even on an actual Linux GitHub-hosted runner. Do
  // not rely on the workstation platform to prevent an accidental real export.
  assert.ok(
    args.length !== 1 ||
      args[0] !== '--run' ||
      requiredContextKeys.some((key) => !environment[key]) ||
      dockerContextKeys.some((key) => Boolean(environment[key])),
    'Offline CLI fixtures must fail a platform-independent mandatory condition',
  );
  const result = spawnSync(process.execPath, ['--import', noEffectsImport, exporterPath, ...args], {
    cwd: exporterRoot,
    env: environment,
    shell: false,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(result.error, undefined, 'Offline context probe must start and finish normally');
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr.trim()), {
    type: 'stopped',
    phase: 'validate_context',
    code: 'DEDICATED_GITHUB_RUNNER_REQUIRED',
    publicDeployment: false,
  });
  for (const value of [simulatedToken, simulatedModelKey, ...privateValues])
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(value),
      false,
      'CLI must not echo private inputs',
    );
  assert.doesNotMatch(
    result.stderr,
    /OFFLINE_TEST_FORBIDDEN_SIDE_EFFECT|UNVERIFIED_EXPORT_RESULT|LOCAL_TOOL_FAILED/u,
  );
}

test('exporter CLI refuses no arguments and incorrect or sensitive arguments before any side effect', () => {
  for (const args of [[], ['--help'], ['--run', '--force'], [`--token=${simulatedToken}`]])
    expectContextRefusal(args, contextEnvironment(), args);
});

test('exporter CLI refuses each missing dedicated CI context condition independently of Windows or Linux', () => {
  for (const key of requiredContextKeys) {
    const environment = contextEnvironment();
    delete environment[key];
    expectContextRefusal(['--run'], environment);
  }
  const noContext = contextEnvironment();
  for (const key of requiredContextKeys) delete noContext[key];
  expectContextRefusal(['--run'], noContext);
});

test('exporter CLI never echoes simulated credentials when mandatory CI context is missing', () => {
  const environment = contextEnvironment();
  delete environment.GITHUB_OUTPUT;
  environment.QWEN_API_KEY = simulatedModelKey;
  environment.GH_TOKEN = simulatedToken;
  expectContextRefusal(['--run'], environment, [environment.RUNNER_TEMP]);
});

test('exporter CLI refuses every Docker endpoint override without contacting it or revealing private values', () => {
  const overrides = {
    DOCKER_HOST: ['tcp://', 'offline-private.invalid:2376/', simulatedToken].join(''),
    DOCKER_CONTEXT: 'offline-private-context-not-to-be-echoed',
    DOCKER_TLS_VERIFY: '1',
    DOCKER_CERT_PATH: join(exporterRoot, 'offline-private-cert-not-to-be-read'),
  };
  for (const [key, value] of Object.entries(overrides))
    expectContextRefusal(
      ['--run'],
      { ...contextEnvironment(), [key]: value },
      key === 'DOCKER_TLS_VERIFY' ? [] : [value],
    );
});

test('error output contains only a static code, never caller-supplied details', () => {
  const error = new OfflineDeliveryError('OFFLINE_PLAN_INVALID');
  assert.equal(error.message, 'OFFLINE_PLAN_INVALID');
  assert.equal(error.code, error.message);
  assert.equal(
    new OfflineDeliveryError('sentinel-private-value').message,
    'OFFLINE_CONTRACT_INVALID',
  );
  assert.equal(
    new OfflineDeliveryError({ message: 'sentinel-private-value' }).code,
    'OFFLINE_CONTRACT_INVALID',
  );
});

test('valid fifteen-key plan is copied and frozen without mutating input or pinning an old source SHA in code', () => {
  const input = plan();
  const checked = validatePlan(input);
  assert.deepEqual(checked, input);
  assert.notEqual(checked, input);
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(Object.isFrozen(checked.images), true);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(REQUIRED_APPS), true);
  assert.equal(validatePlan({ ...input, sourceSha: 'c'.repeat(40) }).sourceSha, 'c'.repeat(40));
});

test('plan rejects missing/extra keys, unknown repository/mode, invalid IDs/hashes and unsafe capacity bounds', () => {
  const p = plan();
  const invalid = [
    null,
    [],
    { ...p, extra: 'sentinel' },
    changed(p, (v) => {
      delete v.sourceCiAttempt;
    }),
    { ...p, repository: 'dingyong221/h5aicustomerservice' },
    { ...p, repository: 'someone/H5AICustomerService' },
    { ...p, pathMode: 'root' },
    { ...p, schemaVersion: '1' },
    { ...p, sourceSha: '0'.repeat(40) },
    { ...p, sourceSha: 'A'.repeat(40) },
    { ...p, sourceManifestSha256: 'f'.repeat(64) },
    { ...p, sourceManifestArchiveSha256: `sha256:${'0'.repeat(64)}` },
    { ...p, maxArchiveBytes: p.maxUnpackedTarBytes + 1 },
    {
      ...p,
      maxArchiveBytes: Number.MAX_SAFE_INTEGER,
      maxUnpackedTarBytes: Number.MAX_SAFE_INTEGER,
    },
  ];
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
    for (const value of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      invalid.push({ ...p, [key]: value });
  }
  for (const value of invalid) expectCode(() => validatePlan(value), 'OFFLINE_PLAN_INVALID');
});

test('plan image map is exactly the five original immutable refs, never tags, credentials or another repository', () => {
  const p = plan();
  for (const mutate of [
    (v) => {
      delete v.images.worker;
    },
    (v) => {
      v.images.extra = p.images.api;
    },
    (v) => {
      v.images.api = p.images.worker;
    },
    (v) => {
      v.images.api = 'ghcr.io/dingyong221/h5aicustomerservice/api:latest';
    },
    (v) => {
      v.images.api = p.images.api.replace('dingyong221', 'someone');
    },
    (v) => {
      v.images.api = p.images.api.replace('ghcr.io/', 'ghcr.io/sentinel@');
    },
    (v) => {
      v.images.api = `ghcr.io/dingyong221/h5aicustomerservice/api@sha256:${'0'.repeat(64)}`;
    },
    (v) => {
      v.images.api += '\n';
    },
  ])
    expectCode(() => validatePlan(changed(p, mutate)), 'OFFLINE_PLAN_INVALID');
});

test('manifest parser verifies exact bytes and returns five immutable reserved tags in canonical app order', () => {
  const p = plan();
  const parsed = parseSourceManifest(manifestText(p.images), p);
  assert.deepEqual(
    parsed,
    REQUIRED_APPS.map((app) => source(p, app)),
  );
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed[0]), true);
  const crlf = manifestText(p.images).replaceAll('\n', '\r\n');
  assert.deepEqual(parseSourceManifest(crlf, { ...p, sourceManifestSha256: hash(crlf) }), parsed);
  expectCode(() => parseSourceManifest(crlf, p), 'OFFLINE_SOURCE_MANIFEST_INVALID');
  const noFinalNewline = manifestText(p.images).trimEnd();
  assert.deepEqual(
    parseSourceManifest(noFinalNewline, { ...p, sourceManifestSha256: hash(noFinalNewline) }),
    parsed,
  );
});

test('source manifest rejects duplicates, extra/missing entries, BOM, whitespace, zero digest and reference drift', () => {
  const p = plan();
  const good = manifestText(p.images);
  const lines = good.trimEnd().split('\n');
  for (const text of [
    '',
    `${good}\n`,
    lines.slice(1).join('\n'),
    `${good}${p.images.api}\n`,
    `${p.images.api}\n${lines.slice(0, -1).join('\n')}\n`,
    `\uFEFF${good}`,
    ` ${good}`,
    good.replace('ghcr.io/', 'other.registry/'),
    good.replace(p.images.api, `${p.images.api} `),
    good.replace(
      p.images.api,
      `ghcr.io/dingyong221/h5aicustomerservice/api@sha256:${'0'.repeat(64)}`,
    ),
  ])
    expectCode(
      () => parseSourceManifest(text, { ...p, sourceManifestSha256: hash(text) }),
      'OFFLINE_SOURCE_MANIFEST_INVALID',
    );
  for (const value of [null, [], 1, 'x'.repeat(4097)])
    expectCode(() => parseSourceManifest(value, p), 'OFFLINE_SOURCE_MANIFEST_INVALID');
});

test('source runs bind exact ID/attempt/workflow/SHA/success and return no unrelated API metadata', () => {
  const p = plan();
  const candidate = validateSourceRun(run(p), p);
  assert.equal(candidate.id, p.sourceCandidateRunId);
  assert.equal(candidate.unrelated, undefined);
  assert.equal(Object.isFrozen(candidate), true);
  for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
    const ci = run(p, 'ci');
    ci.event = event;
    ci.repository.full_name = p.repository.toUpperCase();
    ci.head_repository.full_name = p.repository.toLowerCase();
    assert.equal(validateSourceRun(ci, p, 'ci').event, event);
  }
});

test('source run validation rejects fork/repository confusion, reruns, wrong workflows, incomplete and failed results', () => {
  const p = plan();
  for (const patch of [
    { id: p.sourceCandidateRunId + 1 },
    { id: String(p.sourceCandidateRunId) },
    { run_attempt: 2 },
    { head_sha: 'b'.repeat(40) },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { event: 'push' },
    { path: '.github/workflows/ci.yml' },
    { path: '.github/workflows/candidate-images.yml@other' },
    { repository: { full_name: 'someone/H5AICustomerService' } },
    { head_repository: { full_name: 'someone/H5AICustomerService' } },
    { head_repository: null },
  ])
    expectCode(() => validateSourceRun({ ...run(p), ...patch }, p), 'OFFLINE_SOURCE_RUN_INVALID');
  expectCode(() => validateSourceRun(run(p), p, 'unknown'), 'OFFLINE_SOURCE_RUN_INVALID');
  expectCode(() => validateSourceRun(null, p), 'OFFLINE_SOURCE_RUN_INVALID');
  expectCode(() => validateSourceRun(run(p, 'ci'), p, 'candidate'), 'OFFLINE_SOURCE_RUN_INVALID');
});

test('pull inspect produces only the seven approved image-record fields with actual config identity and size', () => {
  const p = plan();
  for (const app of REQUIRED_APPS) {
    const input = inspect(p, app);
    const checked = imageRecord(input, source(p, app), p);
    assert.deepEqual(checked, {
      ...source(p, app),
      configDigest: input.Id,
      sizeBytes: input.Size,
      os: 'linux',
      architecture: 'amd64',
    });
    assert.equal(Object.keys(checked).length, 7);
    assert.equal(Object.isFrozen(checked), true);
    assert.doesNotMatch(JSON.stringify(checked), /sentinel|Env/u);
    assert.equal(Object.isFrozen(input), false);
  }
});

test('pull inspect rejects wrong config/platform/user/labels, missing original RepoDigest and invalid sizes', () => {
  const p = plan();
  const invalid = [
    null,
    [],
    {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: hash('descriptor'),
      size: 1000,
    },
    ...[
      { Id: `sha256:${'0'.repeat(64)}` },
      { Os: 'windows' },
      { Architecture: 'arm64' },
      { Size: 0 },
      { Size: '1000' },
      { Size: -1 },
      { Size: Number.MAX_SAFE_INTEGER + 1 },
      { RepoDigests: [] },
      { RepoDigests: null },
      { RepoDigests: [p.images.worker] },
      { RepoDigests: [1, p.images.api] },
    ].map((patch) => ({ ...inspect(p), ...patch })),
  ];
  for (const mutate of [
    (v) => {
      v.Config.User = 'root';
    },
    (v) => {
      v.Config.User = '1000';
    },
    (v) => {
      v.Config.Labels['org.opencontainers.image.source'] += '/';
    },
    (v) => {
      v.Config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40);
    },
    (v) => {
      v.Config.Labels['org.opencontainers.image.h5cs.web-path-mode'] = 'root';
    },
    (v) => {
      delete v.Config.Labels['org.opencontainers.image.source'];
    },
  ])
    invalid.push(changed(inspect(p), mutate));
  for (const value of invalid)
    expectCode(() => imageRecord(value, source(p), p), 'OFFLINE_SOURCE_IMAGE_INVALID');
  expectCode(
    () => imageRecord(inspect(p), { ...source(p), loadTag: 'unreserved:latest' }, p),
    'OFFLINE_SOURCE_IMAGE_INVALID',
  );
  expectCode(
    () => imageRecord(inspect(p), { ...source(p), imageRef: p.images.worker }, p),
    'OFFLINE_SOURCE_IMAGE_INVALID',
  );
});

test('load verifies config ID, platform, labels and reserved tag without claiming restored RepoDigests', () => {
  const p = plan();
  const pulled = inspect(p);
  const saved = imageRecord(pulled, source(p), p);
  for (const repoDigests of [undefined, null, []]) {
    const loaded = { ...pulled, RepoDigests: repoDigests };
    delete loaded.Size;
    assert.deepEqual(assertLoadedImage(loaded, saved, p), saved);
  }
  for (const patch of [
    { Id: hash('other-config') },
    { Architecture: 'arm64' },
    { Os: 'windows' },
    { RepoTags: [] },
    { RepoTags: ['h5cs-api:latest'] },
    { RepoTags: null },
  ]) {
    expectCode(
      () => assertLoadedImage({ ...pulled, ...patch }, saved, p),
      'OFFLINE_LOADED_IMAGE_INVALID',
    );
  }
  expectCode(
    () =>
      assertLoadedImage(
        changed(pulled, (v) => {
          v.Config.User = 'root';
        }),
        saved,
        p,
      ),
    'OFFLINE_LOADED_IMAGE_INVALID',
  );
  expectCode(
    () =>
      assertLoadedImage(
        changed(pulled, (v) => {
          v.Config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40);
        }),
        saved,
        p,
      ),
    'OFFLINE_LOADED_IMAGE_INVALID',
  );
  expectCode(
    () => assertLoadedImage(pulled, { ...saved, configDigest: 'sha256:0' }, p),
    'OFFLINE_LOADED_IMAGE_INVALID',
  );
});

test('delivery manifest binds every source field and archive while keeping four verification boundaries false', () => {
  const p = plan();
  const input = delivery(p);
  input.images.reverse();
  const checked = validateDeliveryManifest(input, p);
  assert.deepEqual(
    checked.images.map((v) => v.app),
    REQUIRED_APPS,
  );
  for (const key of [
    'registryDigestsRetained',
    'realModelVerified',
    'provenanceAttestationVerified',
    'publicDeployment',
  ])
    assert.equal(checked[key], false);
  for (const value of [checked, checked.archive, checked.images, ...checked.images])
    assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.images), false);
});

test('delivery rejects missing/extra keys, mismatched identity, unsafe archive names/sizes and false capability claims', () => {
  const p = plan();
  const input = delivery(p);
  const invalid = [
    null,
    [],
    { ...input, sourceCandidateAttempt: 1 },
    changed(input, (v) => {
      delete v.registryDigestsRetained;
    }),
    { ...input, format: 'other' },
    { ...input, transportSha: '0'.repeat(40) },
    { ...input, transportRunId: '104' },
  ];
  for (const key of [
    'repository',
    'sourceSha',
    'pathMode',
    'sourceCandidateRunId',
    'sourceCiRunId',
    'sourceManifestArtifactId',
    'sourceManifestArchiveSha256',
    'sourceManifestSha256',
  ])
    invalid.push({ ...input, [key]: 'sentinel-private-value' });
  for (const key of [
    'registryDigestsRetained',
    'realModelVerified',
    'provenanceAttestationVerified',
    'publicDeployment',
  ]) {
    for (const value of [true, 0, null, 'false']) invalid.push({ ...input, [key]: value });
  }
  for (const patch of [
    { filename: '../candidate-images.tar.gz' },
    { filename: '/candidate-images.tar.gz' },
    { filename: 'candidate-images.tar' },
    { sha256: `sha256:${'0'.repeat(64)}` },
    { sizeBytes: 0 },
    { sizeBytes: p.maxArchiveBytes + 1 },
    { sizeBytes: '1000' },
    { unpackedTarBytes: 0 },
    { unpackedTarBytes: p.maxUnpackedTarBytes + 1 },
    { extra: true },
  ])
    invalid.push({ ...input, archive: { ...input.archive, ...patch } });
  for (const value of invalid)
    expectCode(() => validateDeliveryManifest(value, p), 'OFFLINE_DELIVERY_MANIFEST_INVALID');
});

test('delivery timestamp accepts only canonical real UTC ISO dates, not loose or normalized invalid dates', () => {
  const p = plan();
  const input = delivery(p);
  for (const createdAt of [
    '2026-02-30T12:34:56.789Z',
    '2026-13-01T12:34:56.789Z',
    '2026-10-20T24:00:00.000Z',
    '2026-10-20T12:34:60.000Z',
    '2026-10-20T12:34:56Z',
    '2026-10-20T12:34:56.789+00:00',
    '2026-10-20',
    'Sat, 17 Oct 2026 12:34:56 GMT',
    `${input.createdAt}\n`,
    1,
    null,
  ])
    expectCode(
      () => validateDeliveryManifest({ ...input, createdAt }, p),
      'OFFLINE_DELIVERY_MANIFEST_INVALID',
    );
  assert.equal(
    validateDeliveryManifest({ ...input, createdAt: '2028-02-29T12:34:56.789Z' }, p).createdAt,
    '2028-02-29T12:34:56.789Z',
  );
});

test('delivery image set rejects duplicate apps/config IDs, wrong refs/tags/platform, sparse arrays and extra fields', () => {
  const p = plan();
  for (const mutate of [
    (v) => {
      v.images.pop();
    },
    (v) => {
      v.images.push(v.images[0]);
    },
    (v) => {
      v.images[1] = v.images[0];
    },
    (v) => {
      v.images[1].configDigest = v.images[0].configDigest;
    },
    (v) => {
      v.images[0].imageRef = p.images.worker;
    },
    (v) => {
      v.images[0].loadTag += '-other';
    },
    (v) => {
      v.images[0].os = 'windows';
    },
    (v) => {
      v.images[0].architecture = 'arm64';
    },
    (v) => {
      v.images[0].sizeBytes = 0;
    },
    (v) => {
      v.images[0].extra = true;
    },
    (v) => {
      delete v.images[1];
    },
    (v) => {
      v.images.extra = true;
    },
  ])
    expectCode(
      () => validateDeliveryManifest(changed(delivery(p), mutate), p),
      'OFFLINE_DELIVERY_MANIFEST_INVALID',
    );
});

test('transport paths accept only a nonempty duplicate-free subset of the exact six reviewed paths', () => {
  const paths = [
    '.github/workflows/ci.yml',
    'scripts/quality/candidate-offline-contract.mjs',
    'scripts/quality/candidate-offline-contract.test.mjs',
    'scripts/quality/export-candidate-offline.mjs',
    'scripts/operations/r1-offline-delivery-plan.json',
    'docs/operations/2026-10-17-offline-candidate-delivery.md',
  ];
  assert.deepEqual(assertTransportOnlyPaths(paths), paths);
  assert.equal(Object.isFrozen(assertTransportOnlyPaths(paths.slice(0, 1))), true);
  for (const invalid of [
    [],
    null,
    'ci.yml',
    [paths[0], paths[0]],
    ['ci.yml'],
    ['.github/workflows/candidate-images.yml'],
    ['apps/api/src/main.ts'],
    ['../.github/workflows/ci.yml'],
    ['./.github/workflows/ci.yml'],
    ['/.github/workflows/ci.yml'],
    ['F:/project/.github/workflows/ci.yml'],
    ['.github\\workflows\\ci.yml'],
    ['.GITHUB/workflows/ci.yml'],
    [`${paths[0]}\n`],
  ])
    expectCode(() => assertTransportOnlyPaths(invalid), 'OFFLINE_TRANSPORT_PATHS_INVALID');
});

test('strict JSON objects reject accessors, prototypes and hidden keys before evaluating caller values', () => {
  const p = plan();
  const getter = { ...p };
  Object.defineProperty(getter, 'repository', {
    get() {
      throw new Error('sentinel-private-value');
    },
    enumerable: true,
  });
  expectCode(() => validatePlan(getter), 'OFFLINE_PLAN_INVALID');
  expectCode(
    () => validatePlan(Object.assign(Object.create({ inherited: true }), p)),
    'OFFLINE_PLAN_INVALID',
  );
  const hidden = { ...p };
  Object.defineProperty(hidden, 'hidden', { value: true });
  expectCode(() => validatePlan(hidden), 'OFFLINE_PLAN_INVALID');
  const symbol = { ...p, [Symbol('sentinel')]: true };
  expectCode(() => validatePlan(symbol), 'OFFLINE_PLAN_INVALID');
});

test('only dedicated manual transport skips application jobs; main, PR and other manual branches retain them', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const branch = 'codex/offline-one-assistant-context';
  const ordinaryCondition = `    if: \${{ github.event_name != 'workflow_dispatch' || github.ref_name != '${branch}' }}`;
  const offlineCondition = `    if: \${{ github.event_name == 'workflow_dispatch' && github.ref_name == '${branch}' }}`;
  for (const job of ['quality', 'mysql-integration', 'browser-e2e', 'image-packaging']) {
    const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z][a-z0-9-]*:\n/u)[0];
    assert.ok(block, `Existing job ${job} remains present`);
    assert.equal(block.split(ordinaryCondition).length, 2);
  }
  assert.equal(workflow.split(offlineCondition).length, 2);
  const shouldRunApplication = (event, ref) => event !== 'workflow_dispatch' || ref !== branch;
  for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
    for (const ref of ['main', branch, 'codex/offline-candidate-delivery', 'codex/other']) {
      assert.equal(
        shouldRunApplication(event, ref),
        !(event === 'workflow_dispatch' && ref === branch),
      );
    }
  }
});
