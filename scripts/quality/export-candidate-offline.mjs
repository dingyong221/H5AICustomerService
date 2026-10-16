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
import { spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

import {
  OfflineDeliveryError,
  assertLoadedImage,
  assertTransportOnlyPaths,
  imageRecord,
  parseSourceManifest,
  validateDeliveryManifest,
  validatePlan,
  validateSourceRun,
} from './candidate-offline-contract.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const planFile = new URL('../operations/r1-offline-delivery-plan.json', import.meta.url);
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fail = (code) => {
  throw new OfflineDeliveryError(code);
};

function childEnvironment(environment) {
  // Authentication remains in the runner's Docker login configuration. Never
  // forward the GitHub API token or unrelated workflow secrets to child tools.
  return Object.fromEntries(
    ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'DOCKER_CONFIG', 'TMPDIR', 'TEMP', 'TMP']
      .filter((name) => typeof environment[name] === 'string')
      .map((name) => [name, environment[name]]),
  );
}

function command(program, args, environment, { allowMissing = false, timeout = 300_000 } = {}) {
  const result = spawnSync(program, args, {
    cwd: repositoryRoot,
    env: childEnvironment(environment),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout,
    shell: false,
  });
  if (result.error || (result.status !== 0 && !(allowMissing && result.status === 1)))
    fail('LOCAL_TOOL_FAILED');
  return { status: result.status, stdout: result.stdout ?? '' };
}

function inspectImage(reference, environment) {
  const result = command('docker', ['image', 'inspect', reference], environment);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail('INVALID_DOCKER_INSPECT_RESULT');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) fail('INVALID_DOCKER_INSPECT_RESULT');
  return parsed[0];
}

async function boundedJson(url, token) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok || !response.body) fail('GITHUB_SOURCE_READ_FAILED');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) fail('OVERSIZED_GITHUB_RESPONSE');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('INVALID_GITHUB_SOURCE_RESPONSE');
  }
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function readSmallRegularFile(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    fail('INVALID_SOURCE_EVIDENCE_FILE');
  return readFile(path);
}

export async function exportCandidateOffline(
  environment = process.env,
  args = process.argv.slice(2),
) {
  let phase = 'validate_context';
  const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    if (
      args.length !== 1 ||
      args[0] !== '--run' ||
      process.platform !== 'linux' ||
      environment.CI !== 'true' ||
      environment.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      environment.GITHUB_REF_NAME !== 'codex/offline-candidate-delivery' ||
      environment.GITHUB_REPOSITORY !== 'dingyong221/H5AICustomerService' ||
      !/^[0-9a-f]{40}$/u.test(environment.GITHUB_SHA ?? '') ||
      !/^[1-9][0-9]{0,15}$/u.test(environment.GITHUB_RUN_ID ?? '') ||
      !environment.GITHUB_TOKEN ||
      !environment.RUNNER_TEMP ||
      !isAbsolute(environment.RUNNER_TEMP) ||
      !environment.GITHUB_OUTPUT ||
      !isAbsolute(environment.GITHUB_OUTPUT) ||
      ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].some((name) =>
        Boolean(environment[name]),
      )
    )
      fail('DEDICATED_GITHUB_RUNNER_REQUIRED');

    const plan = validatePlan(JSON.parse(await readFile(planFile, 'utf8')));
    const transportRunId = Number(environment.GITHUB_RUN_ID);
    if (!Number.isSafeInteger(transportRunId)) fail('INVALID_TRANSPORT_RUN_ID');
    const actualCommit = command('git', ['rev-parse', 'HEAD'], environment).stdout.trim();
    if (actualCommit !== environment.GITHUB_SHA) fail('TRANSPORT_CHECKOUT_MISMATCH');
    const changed = command(
      'git',
      ['diff', '--name-only', plan.sourceSha, actualCommit, '--'],
      environment,
    )
      .stdout.trim()
      .split(/\r?\n/u)
      .filter(Boolean);
    assertTransportOnlyPaths(changed);

    const context = command('docker', ['context', 'show'], environment).stdout.trim();
    if (context !== 'default') fail('LOCAL_DEFAULT_DOCKER_REQUIRED');
    const endpoint = command(
      'docker',
      ['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}'],
      environment,
    ).stdout.trim();
    if (endpoint !== 'unix:///var/run/docker.sock') fail('LOCAL_DEFAULT_DOCKER_REQUIRED');
    command('docker', ['version', '--format', '{{.Server.Version}}'], environment);

    phase = 'verify_source_runs';
    const api = `https://api.github.com/repos/${plan.repository}`;
    const [candidateRun, ciRun, artifact, jobs] = await Promise.all([
      boundedJson(`${api}/actions/runs/${plan.sourceCandidateRunId}`, environment.GITHUB_TOKEN),
      boundedJson(`${api}/actions/runs/${plan.sourceCiRunId}`, environment.GITHUB_TOKEN),
      boundedJson(
        `${api}/actions/artifacts/${plan.sourceManifestArtifactId}`,
        environment.GITHUB_TOKEN,
      ),
      boundedJson(
        `${api}/actions/runs/${plan.sourceCandidateRunId}/attempts/${plan.sourceCandidateAttempt}/jobs?per_page=100`,
        environment.GITHUB_TOKEN,
      ),
    ]);
    validateSourceRun(candidateRun, plan, 'candidate');
    validateSourceRun(ciRun, plan, 'ci');
    if (
      artifact.id !== plan.sourceManifestArtifactId ||
      artifact.name !== `candidate-images-${plan.sourceSha}` ||
      artifact.digest !== plan.sourceManifestArchiveSha256 ||
      artifact.expired !== false ||
      artifact.workflow_run?.id !== plan.sourceCandidateRunId ||
      artifact.workflow_run?.head_sha !== plan.sourceSha ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1 ||
      artifact.size_in_bytes > 8192
    )
      fail('SOURCE_ARTIFACT_METADATA_MISMATCH');
    const expectedJobs = new Set([
      'Verify repository release gate',
      'Build api image',
      'Build worker image',
      'Build merchant-web image',
      'Build consumer-h5 image',
      'Build ops-web image',
      'Collect five image digests',
      'Browser flow using the five published digests',
    ]);
    if (jobs.total_count !== expectedJobs.size || !Array.isArray(jobs.jobs))
      fail('SOURCE_JOB_SET_MISMATCH');
    for (const job of jobs.jobs) {
      if (
        !expectedJobs.delete(job.name) ||
        job.head_sha !== plan.sourceSha ||
        job.status !== 'completed' ||
        job.conclusion !== 'success'
      )
        fail('SOURCE_JOB_NOT_VERIFIED');
    }
    if (expectedJobs.size !== 0) fail('SOURCE_JOB_SET_MISMATCH');

    phase = 'verify_source_manifest';
    const temporaryRoot = await realpath(environment.RUNNER_TEMP);
    const sourceDirectory = join(temporaryRoot, 'h5cs-offline-source-manifest');
    const sourceInfo = await lstat(sourceDirectory);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
      fail('INVALID_SOURCE_EVIDENCE_DIRECTORY');
    const manifest = await readSmallRegularFile(
      join(sourceDirectory, 'candidate-images.txt'),
      8192,
    );
    const mode = await readSmallRegularFile(join(sourceDirectory, 'web-path-mode.txt'), 64);
    if (sha256(manifest) !== plan.sourceManifestSha256 || mode.toString('utf8') !== 'same_domain\n')
      fail('SOURCE_MANIFEST_HASH_OR_MODE_MISMATCH');
    const sourceImages = parseSourceManifest(manifest.toString('utf8'), plan);

    phase = 'pull_exact_images';
    const baselineIds = new Set(
      command('docker', ['image', 'ls', '--no-trunc', '--quiet'], environment)
        .stdout.trim()
        .split(/\r?\n/u)
        .filter(Boolean),
    );
    const records = [];
    for (const source of sourceImages) {
      for (const reference of [source.imageRef, source.loadTag]) {
        if (
          command('docker', ['image', 'inspect', reference], environment, { allowMissing: true })
            .status !== 1
        )
          fail('PREEXISTING_IMAGE_REFERENCE');
      }
      output({ type: 'progress', phase, app: source.app, sourceSha: plan.sourceSha });
      command('docker', ['pull', '--platform=linux/amd64', source.imageRef], environment);
      const record = imageRecord(inspectImage(source.imageRef, environment), source, plan);
      if (baselineIds.has(record.configDigest)) fail('PREEXISTING_IMAGE_CONFIG');
      const users = command(
        'docker',
        ['container', 'ls', '--all', '--quiet', '--filter', `ancestor=${record.configDigest}`],
        environment,
      ).stdout.trim();
      if (users) fail('IMAGE_USED_BY_EXISTING_CONTAINER');
      command('docker', ['tag', source.imageRef, source.loadTag], environment);
      records.push(record);
    }
    if (new Set(records.map((record) => record.configDigest)).size !== sourceImages.length)
      fail('DUPLICATE_IMAGE_CONFIG');

    phase = 'check_export_capacity';
    const imageBytes = records.reduce((total, record) => total + record.sizeBytes, 0);
    const disk = await statfs(temporaryRoot, { bigint: true });
    const freeBytes = disk.bavail * disk.bsize;
    if (
      !Number.isSafeInteger(imageBytes) ||
      imageBytes > plan.maxUnpackedTarBytes ||
      freeBytes < BigInt(imageBytes * 2 + plan.maxArchiveBytes + plan.minimumRunnerFreeBytes)
    )
      fail('INSUFFICIENT_EPHEMERAL_EXPORT_CAPACITY');

    const directory = await mkdtemp(join(temporaryRoot, 'h5cs-offline-'));
    const tarPath = join(directory, 'candidate-images.tar');
    const archivePath = join(directory, 'candidate-images.tar.gz');
    phase = 'save_exact_images';
    command(
      'docker',
      ['image', 'save', '--output', tarPath, ...records.map((record) => record.loadTag)],
      environment,
    );
    const tarInfo = await lstat(tarPath);
    if (!tarInfo.isFile() || tarInfo.isSymbolicLink() || tarInfo.size > plan.maxUnpackedTarBytes)
      fail('INVALID_OR_OVERSIZED_DOCKER_ARCHIVE');
    phase = 'compress_bounded_archive';
    let compressedBytes = 0;
    const boundedOutput = new Transform({
      transform(chunk, _encoding, callback) {
        compressedBytes += chunk.length;
        if (compressedBytes > plan.maxArchiveBytes)
          callback(new OfflineDeliveryError('OVERSIZED_COMPRESSED_ARCHIVE'));
        else callback(null, chunk);
      },
    });
    await pipeline(
      createReadStream(tarPath),
      createGzip({ level: 1 }),
      boundedOutput,
      createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
    );
    const archiveInfo = await lstat(archivePath);
    const archiveHash = await digestFile(archivePath);
    // This is the exact regular file generated in our mkdtemp directory, never
    // a workspace or business file. No recursive deletion or Docker prune.
    if ((await realpath(tarPath)) !== tarPath || dirname(tarPath) !== directory)
      fail('GENERATED_TAR_IDENTITY_CHANGED');
    await unlink(tarPath);

    phase = 'remove_only_exported_images';
    for (const record of records) {
      // Removing the last tag can also remove its repository digest. Inspect
      // each exact reference first; never ignore an actual removal failure.
      for (const reference of [record.loadTag, record.imageRef]) {
        if (
          command('docker', ['image', 'inspect', reference], environment, { allowMissing: true })
            .status === 0
        )
          command('docker', ['image', 'rm', reference], environment);
      }
      if (
        command('docker', ['image', 'inspect', record.configDigest], environment, {
          allowMissing: true,
        }).status !== 1
      )
        fail('ROUNDTRIP_IMAGE_WAS_NOT_REMOVED');
    }
    phase = 'reload_verified_archive';
    command('docker', ['image', 'load', '--input', archivePath], environment);
    for (const record of records)
      assertLoadedImage(inspectImage(record.loadTag, environment), record, plan);

    const delivery = validateDeliveryManifest(
      {
        format: 'h5cs-candidate-offline-v1',
        repository: plan.repository,
        sourceSha: plan.sourceSha,
        pathMode: plan.pathMode,
        sourceCandidateRunId: plan.sourceCandidateRunId,
        sourceCiRunId: plan.sourceCiRunId,
        sourceManifestArtifactId: plan.sourceManifestArtifactId,
        sourceManifestArchiveSha256: plan.sourceManifestArchiveSha256,
        sourceManifestSha256: plan.sourceManifestSha256,
        transportSha: actualCommit,
        transportRunId,
        createdAt: new Date().toISOString(),
        archive: {
          filename: 'candidate-images.tar.gz',
          sha256: archiveHash,
          sizeBytes: archiveInfo.size,
          unpackedTarBytes: tarInfo.size,
        },
        images: records,
        registryDigestsRetained: false,
        realModelVerified: false,
        provenanceAttestationVerified: false,
        publicDeployment: false,
      },
      plan,
    );
    phase = 'write_delivery_evidence';
    await writeFile(join(directory, 'delivery.json'), `${JSON.stringify(delivery, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    if (/[\r\n]/u.test(directory) || dirname(directory) !== temporaryRoot)
      fail('INVALID_OUTPUT_DIRECTORY');
    await appendFile(environment.GITHUB_OUTPUT, `artifact_directory=${directory}\n`);
    output({
      type: 'completed',
      sourceSha: plan.sourceSha,
      transportSha: actualCommit,
      archiveSha256: archiveHash,
      compressedBytes: archiveInfo.size,
      unpackedTarBytes: tarInfo.size,
      imageCount: records.length,
      roundtripConfigIdsVerified: true,
      registryDigestsRetained: false,
      realModelVerified: false,
      publicDeployment: false,
    });
    return true;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ type: 'stopped', phase, code: error instanceof OfflineDeliveryError ? error.code : 'UNVERIFIED_EXPORT_RESULT', publicDeployment: false })}\n`,
    );
    return false;
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly && !(await exportCandidateOffline())) process.exitCode = 1;
