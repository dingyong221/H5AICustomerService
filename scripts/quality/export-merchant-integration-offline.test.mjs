import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SOURCE_SHA,
  BASE_SHA,
  SOURCE_CI_RUN_ID,
  BRANCH,
  APPLICATION_PATHS,
  TRANSPORT_PATHS,
  CI_JOBS,
  LOAD_TAG,
  exactPaths,
  childEnvironment,
  validateContext,
  validateCi,
  validateImage,
  validateOwnedReferences,
  validateArchiveGraph,
  boundedStream,
} from './export-merchant-integration-offline.mjs';
const hash = (char) => `sha256:${char.repeat(64)}`;
const bad = (fn, code) => assert.throws(fn, (e) => e.code === code);
const context = () => ({
  CI: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF_NAME: BRANCH,
  GITHUB_REPOSITORY: 'dingyong221/H5AICustomerService',
  GITHUB_SHA: 'f'.repeat(40),
  GITHUB_RUN_ID: '1234',
  RUNNER_TEMP: '/tmp/runner',
  GITHUB_OUTPUT: '/tmp/output',
});
const labels = () => ({
  'org.opencontainers.image.source': 'https://github.com/dingyong221/H5AICustomerService',
  'org.opencontainers.image.revision': SOURCE_SHA,
  'org.opencontainers.image.h5cs.web-path-mode': 'same_domain',
});
const image = () => ({
  Id: hash('c'),
  Os: 'linux',
  Architecture: 'amd64',
  Size: 1234,
  Config: { User: 'node', Labels: labels() },
  RootFS: { Type: 'layers', Layers: [hash('a'), hash('b')] },
});
const ci = () => ({
  id: SOURCE_CI_RUN_ID,
  run_attempt: 1,
  head_sha: SOURCE_SHA,
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
  event: 'pull_request',
  repository: { full_name: 'dingyong221/H5AICustomerService' },
  head_repository: { full_name: 'dingyong221/H5AICustomerService' },
});
const jobs = () => ({
  total_count: 4,
  jobs: CI_JOBS.map((name) => ({
    name,
    head_sha: SOURCE_SHA,
    status: 'completed',
    conclusion: 'success',
  })),
});

test('fixed source differs from compatible base; only three reviewed merchant and three transport paths', () => {
  assert.equal(SOURCE_SHA, 'c2f9bd41f97a2da0b2f0d6f85ce245116ee0ad16');
  assert.equal(BASE_SHA, '07b6ae07052e4ed2f4200b23f3492cd10255ff26');
  assert.notEqual(SOURCE_SHA, BASE_SHA);
  assert.equal(APPLICATION_PATHS.length, 3);
  assert.ok(APPLICATION_PATHS.every((p) => p.startsWith('apps/merchant-web/')));
  assert.equal(TRANSPORT_PATHS.length, 3);
  exactPaths([...APPLICATION_PATHS].reverse(), APPLICATION_PATHS);
  for (const paths of [
    [],
    [...APPLICATION_PATHS, 'apps/worker/src/main.ts'],
    [APPLICATION_PATHS[0], APPLICATION_PATHS[0], APPLICATION_PATHS[2]],
    ['../apps/merchant-web/app/assistant-view.tsx'],
  ])
    bad(() => exactPaths(paths, APPLICATION_PATHS), 'SOURCE_OR_TRANSPORT_PATHS_INVALID');
});
test('dedicated context rejects other ref/event/platform/socket and malformed run metadata', () => {
  validateContext(context(), 'linux');
  for (const changed of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF_NAME: 'main' },
    { GITHUB_REF_NAME: 'codex/other' },
    { GITHUB_REPOSITORY: 'other/repository' },
    { CI: 'false' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_SHA: 'x' },
    { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ID: '9999999999999999' },
    { RUNNER_TEMP: 'relative' },
    { GITHUB_OUTPUT: 'relative' },
    { DOCKER_HOST: 'tcp://not-allowed' },
    { DOCKER_CONTEXT: 'remote' },
    { DOCKER_TLS_VERIFY: '1' },
    { DOCKER_CERT_PATH: '/not-allowed' },
  ])
    bad(() => validateContext({ ...context(), ...changed }, 'linux'), 'DEDICATED_RUNNER_REQUIRED');
  bad(() => validateContext(context(), 'win32'), 'DEDICATED_RUNNER_REQUIRED');
});
test('child tools never inherit API tokens or arbitrary environment secrets', () => {
  const result = childEnvironment({
    ...context(),
    PATH: '/bin',
    HOME: '/tmp/home',
    GITHUB_TOKEN: 'NOT_A_REAL_TOKEN',
    MODEL_API_KEY: 'NOT_A_REAL_KEY',
  });
  assert.deepEqual(result, { PATH: '/bin', HOME: '/tmp/home' });
});
test('exact successful source CI and four ordinary jobs required', () => {
  assert.equal(validateCi(ci(), jobs()).runId, SOURCE_CI_RUN_ID);
  for (const changed of [
    { id: SOURCE_CI_RUN_ID + 1 },
    { run_attempt: 2 },
    { head_sha: BASE_SHA },
    { path: '.github/workflows/candidate-images.yml' },
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { event: 'schedule' },
    { run_attempt: 0 },
    { repository: { full_name: 'fork/repo' } },
    { head_repository: { full_name: 'fork/repo' } },
  ])
    bad(() => validateCi({ ...ci(), ...changed }, jobs()), 'SOURCE_CI_NOT_VERIFIED');
  bad(() => validateCi(ci(), { ...jobs(), total_count: 3 }), 'SOURCE_CI_JOB_SET_INVALID');
  for (const changed of [
    { name: 'unexpected' },
    { head_sha: BASE_SHA },
    { status: 'in_progress' },
    { conclusion: 'skipped' },
  ]) {
    const list = jobs();
    list.jobs[0] = { ...list.jobs[0], ...changed };
    bad(() => validateCi(ci(), list), 'SOURCE_CI_JOB_NOT_SUCCESSFUL');
  }
  const duplicate = jobs();
  duplicate.jobs[1] = duplicate.jobs[0];
  bad(() => validateCi(ci(), duplicate), 'SOURCE_CI_JOB_NOT_SUCCESSFUL');
});
test('runtime non-root platform, exact source and same-domain labels are mandatory', () => {
  const result = validateImage(image());
  assert.equal(result.runtimeImageId, hash('c'));
  assert.deepEqual(result.rootFsDiffIds, [hash('a'), hash('b')]);
  for (const changed of [
    { Id: 'sha256:bad' },
    { Os: 'windows' },
    { Architecture: 'arm64' },
    { Size: 0 },
    { Config: { User: 'root', Labels: labels() } },
    { RootFS: { Type: 'layers', Layers: [] } },
  ])
    bad(() => validateImage({ ...image(), ...changed }), 'IMAGE_IDENTITY_INVALID');
  for (const [key, value] of [
    ['org.opencontainers.image.source', 'https://github.com/other/repo'],
    ['org.opencontainers.image.revision', BASE_SHA],
    ['org.opencontainers.image.h5cs.web-path-mode', 'root'],
  ])
    bad(
      () =>
        validateImage({
          ...image(),
          Config: { User: 'node', Labels: { ...labels(), [key]: value } },
        }),
      'IMAGE_SOURCE_LABELS_INVALID',
    );
});

test('only the newly built ci and reserved load references may be removed', () => {
  validateOwnedReferences({ RepoTags: ['h5cs-merchant-web:ci'], RepoDigests: [] }, [
    'h5cs-merchant-web:ci',
  ]);
  validateOwnedReferences({ RepoTags: [LOAD_TAG, 'h5cs-merchant-web:ci'], RepoDigests: [] }, [
    'h5cs-merchant-web:ci',
    LOAD_TAG,
  ]);
  for (const object of [
    { RepoTags: ['h5cs-merchant-web:ci', 'unrelated:keep'], RepoDigests: [] },
    { RepoTags: ['h5cs-merchant-web:ci', 'h5cs-merchant-web:ci'], RepoDigests: [] },
    { RepoTags: ['h5cs-merchant-web:ci'], RepoDigests: ['ghcr.io/unrelated/image@' + hash('a')] },
    { RepoTags: [], RepoDigests: [] },
    { RepoTags: ['h5cs-merchant-web:ci'] },
  ])
    bad(() => validateOwnedReferences(object, ['h5cs-merchant-web:ci']), 'UNKNOWN_IMAGE_REFERENCE');
});
const inventory = () => ({
  entries: {
    'manifest.json': { sha256: hash('e'), sizeBytes: 10 },
    'config.json': { sha256: hash('c'), sizeBytes: 100 },
    'layer-a.tar': { sha256: hash('a'), sizeBytes: 11 },
    'layer-b.tar': { sha256: hash('b'), sizeBytes: 12 },
  },
  json: {
    'manifest.json': [
      { Config: 'config.json', RepoTags: [LOAD_TAG], Layers: ['layer-a.tar', 'layer-b.tar'] },
    ],
    'config.json': {
      os: 'linux',
      architecture: 'amd64',
      config: { User: 'node', Labels: labels() },
      rootfs: { diff_ids: [hash('a'), hash('b')] },
    },
  },
});
test('legacy Docker save graph binds config bytes, load tag and rootfs without fake RepoDigest', () => {
  const result = validateArchiveGraph(inventory(), validateImage(image()));
  assert.equal(result.configDigest, hash('c'));
  assert.equal(result.rootIndexSha256, null);
  assert.deepEqual(result.manifestDigests, []);
  assert.equal(result.configAndRuntimeBound, true);
  const wrongTag = inventory();
  wrongTag.json['manifest.json'][0].RepoTags = ['other:tag'];
  bad(
    () => validateArchiveGraph(wrongTag, validateImage(image())),
    'ARCHIVE_TAG_OR_LAYERS_INVALID',
  );
  const wrongConfig = inventory();
  wrongConfig.json['config.json'].rootfs.diff_ids = [hash('a')];
  bad(() => validateArchiveGraph(wrongConfig, validateImage(image())), 'ARCHIVE_CONFIG_INVALID');
  const oldSource = inventory();
  oldSource.json['config.json'].config.Labels['org.opencontainers.image.revision'] = BASE_SHA;
  bad(
    () => validateArchiveGraph(oldSource, validateImage(image())),
    'ARCHIVE_CONFIG_LABELS_INVALID',
  );
  bad(
    () =>
      validateArchiveGraph(inventory(), { ...validateImage(image()), runtimeImageId: hash('d') }),
    'RUNTIME_NOT_BOUND_TO_ARCHIVE',
  );
});
test('OCI manifest runtime digest is distinct from config and verified layers bind both', () => {
  const value = inventory();
  value.entries['blobs/sha256/' + 'd'.repeat(64)] = { sha256: hash('d'), sizeBytes: 200 };
  value.json['blobs/sha256/' + 'd'.repeat(64)] = {
    schemaVersion: 2,
    config: { digest: hash('c') },
    layers: [
      { digest: hash('a'), size: 11 },
      { digest: hash('b'), size: 12 },
    ],
  };
  const result = validateArchiveGraph(value, {
    ...validateImage(image()),
    runtimeImageId: hash('d'),
  });
  assert.equal(result.configDigest, hash('c'));
  assert.deepEqual(result.manifestDigests, [hash('d')]);
  value.json['blobs/sha256/' + 'd'.repeat(64)].layers[0].size = 999;
  bad(() => validateArchiveGraph(value, validateImage(image())), 'OCI_MANIFEST_LAYER_INVALID');
});
test('archive writer bounds exact bytes without forwarding the overflowing chunk', async () => {
  const within = boundedStream(4),
    seen = [];
  await pipeline(
    Readable.from([Buffer.from('12'), Buffer.from('34')]),
    within.stream,
    new Writable({
      write(c, e, done) {
        seen.push(c);
        done();
      },
    }),
  );
  assert.equal(within.count(), 4);
  assert.equal(Buffer.concat(seen).toString(), '1234');
  const outside = boundedStream(3),
    seenOutside = [];
  await assert.rejects(
    pipeline(
      Readable.from([Buffer.from('12'), Buffer.from('34')]),
      outside.stream,
      new Writable({
        write(c, e, done) {
          seenOutside.push(c);
          done();
        },
      }),
    ),
    (e) => e.code === 'ARCHIVE_LIMIT_EXCEEDED',
  );
  assert.equal(Buffer.concat(seenOutside).toString(), '12');
  for (const n of [0, -1, NaN, 1.5, Infinity]) bad(() => boundedStream(n), 'INVALID_STREAM_LIMIT');
});
test('workflow frozen source and strict non-deployment permissions, restricted smoke and artifact bounds remain explicit', () => {
  const draft = new URL('./merchant-offline-integration.yml', import.meta.url);
  let path = draft;
  try {
    readFileSync(path);
  } catch {
    path = new URL('../../.github/workflows/ci.yml', import.meta.url);
  }
  const workflow = readFileSync(path, 'utf8');
  assert.ok(workflow.includes(`ref: ${SOURCE_SHA}`));
  assert.ok(workflow.includes(`github.ref_name == '${BRANCH}'`));
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /actions: read/u);
  assert.doesNotMatch(
    workflow,
    /packages: write|id-token: write|docker login|push: true|ssh |scp /u,
  );
  assert.match(workflow, /smoke-release-images\.sh merchant-web/u);
  assert.match(workflow, /APP_NAME=merchant-web/u);
  assert.match(workflow, /NEXT_PUBLIC_MERCHANT_BASE_PATH=\/console/u);
  assert.match(workflow, /retention-days: 1/u);
  assert.match(workflow, /compression-level: 0/u);
});
test('CLI outside dedicated runner refuses before side effects and never prints simulated secrets', () => {
  const script = fileURLToPath(
    new URL('./export-merchant-integration-offline.mjs', import.meta.url),
  );
  const r = spawnSync(process.execPath, [script, '--export'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    env: { ...process.env, CI: 'false', GITHUB_TOKEN: 'DO_NOT_ECHO_SIMULATED_SECRET' },
  });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stderr).code, 'DEDICATED_RUNNER_REQUIRED');
  assert.doesNotMatch(r.stdout + r.stderr, /DO_NOT_ECHO_SIMULATED_SECRET/u);
});
