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
  validateSourceCompatibility,
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

test('fixed 27-path source includes DB extension, dependency fix and CI restore tooling; only merchant runtime is rebuilt', () => {
  assert.equal(SOURCE_SHA, '1fccc6ef067a6f489f4f5943946273c553d577e4');
  assert.equal(BASE_SHA, 'ecee2c9d07a6691d513d54ac3519d6016812548e');
  assert.notEqual(SOURCE_SHA, BASE_SHA);
  assert.equal(APPLICATION_PATHS.length, 27);
  assert.deepEqual([...APPLICATION_PATHS].sort(), [
    'apps/api/integration/knowledge-material-delete.integration.ts',
    'apps/api/package.json',
    'apps/merchant-web/app/[merchantId]/knowledge/[assistantId]/materials/delete/route.ts',
    'apps/merchant-web/app/assistant-view.test.tsx',
    'apps/merchant-web/app/assistant-view.tsx',
    'apps/merchant-web/app/help/manual-publishing.test.ts',
    'apps/merchant-web/app/help/manual.ts',
    'apps/merchant-web/app/knowledge/material-manager.test.tsx',
    'apps/merchant-web/app/knowledge/material-manager.tsx',
    'apps/merchant-web/app/knowledge/material-routes.test.ts',
    'apps/merchant-web/app/share-assistant-link-view.test.ts',
    'apps/merchant-web/app/share-assistant-link.tsx',
    'apps/merchant-web/app/workspace/publication-policy.test.ts',
    'apps/merchant-web/app/workspace/publication-policy.ts',
    'apps/merchant-web/app/workspace/publish-actions.test.ts',
    'apps/merchant-web/app/workspace/publish-actions.ts',
    'apps/merchant-web/app/workspace/publish-assistant-form.test.ts',
    'apps/merchant-web/app/workspace/publish-assistant-form.tsx',
    'package.json',
    'packages/database/src/knowledge-material-repository.ts',
    'packages/database/test/knowledge-material-repository.test.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/quality/verify-ci-mysql-restore.sh',
    'scripts/quality/verify-ci-mysql-restore.test.mjs',
    'tests/e2e/fake-model.mjs',
    'tests/e2e/merchant-to-consumer.spec.ts',
  ]);
  assert.deepEqual(
    validateSourceCompatibility([...APPLICATION_PATHS].reverse()),
    [...APPLICATION_PATHS].sort(),
  );
  assert.ok(APPLICATION_PATHS.includes('packages/database/src/knowledge-material-repository.ts'));
  assert.ok(
    APPLICATION_PATHS.every(
      (path) =>
        !path.startsWith('packages/database/migrations/') &&
        !path.startsWith('packages/contracts/'),
    ),
  );
  assert.equal(
    APPLICATION_PATHS.filter((path) => !path.startsWith('apps/merchant-web/')).length,
    11,
  );
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
test('four normal jobs remain byte-identical to the source workflow except dedicated manual transport guards', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const marker = '\n  offline-merchant:\n';
  assert.equal(workflow.split(marker).length, 2);
  const guard = `    if: \${{ github.event_name != 'workflow_dispatch' || github.ref_name != '${BRANCH}' }}\n`;
  const normal = workflow.slice(0, workflow.indexOf(marker));
  assert.equal(normal.split(guard).length - 1, 4);
  const source = spawnSync('git', ['show', `${SOURCE_SHA}:.github/workflows/ci.yml`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(source.status, 0, source.stderr);
  assert.equal(
    normal.replaceAll(guard, '').trimEnd(),
    source.stdout.replaceAll('\r\n', '\n').trimEnd(),
  );
  const dedicated = workflow.slice(workflow.indexOf(marker));
  assert.ok(
    dedicated.includes(
      `github.event_name == 'workflow_dispatch' && github.ref_name == '${BRANCH}'`,
    ),
  );
  assert.doesNotMatch(
    dedicated,
    /(?:APP_NAME=|smoke-release-images\.sh )(?:api|worker|ops-web|consumer-h5)/u,
  );
});
test('v2 metadata makes the reviewed shared-DB compatibility exception explicit without a merchant-directory-only claim', () => {
  const helper = readFileSync(
    new URL('./export-merchant-integration-offline.mjs', import.meta.url),
    'utf8',
  );
  assert.match(helper, /format: 'h5cs-merchant-runtime-offline-v2'/u);
  assert.match(helper, /merchantRuntimeOnlyCompatibleWithBase: true/u);
  assert.match(helper, /exactSourcePaths: verified\.sourceChangedPaths/u);
  assert.doesNotMatch(helper, /sourceDiffOnlyMerchant/u);
  const altered = [...APPLICATION_PATHS];
  altered[altered.indexOf('packages/database/src/knowledge-material-repository.ts')] =
    'packages/database/src/config.ts';
  bad(() => validateSourceCompatibility(altered), 'SOURCE_OR_TRANSPORT_PATHS_INVALID');
  bad(
    () =>
      validateSourceCompatibility([
        ...APPLICATION_PATHS,
        'packages/database/migrations/0014_unreviewed.sql',
      ]),
    'SOURCE_OR_TRANSPORT_PATHS_INVALID',
  );
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
