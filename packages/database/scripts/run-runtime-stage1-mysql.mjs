import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnection } from 'mysql2';
import ts from 'typescript';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const worktree = resolve(packageRoot, '../..');
const collaborationRoot = resolve(worktree, '../../..');
const evidenceRoot = resolve(collaborationRoot, 'artifacts/agent-work/WI-20261112-003/local-mysql');
const binary = process.env.H5CS_TEST_MYSQLD ?? 'F:/WorkStation/CODEX/implementations/ai-supermarket/H5AICustomerService/artifacts/ai-supermarket-a6/mysql-runtime/mysql-8.4.13-winx64/bin/mysqld.exe';
const basedir = resolve(dirname(binary), '..');
const mode = process.argv[2] ?? '--all';
if (!['--all', '--runtime-only', '--legacy-only'].includes(mode) || process.argv.length > 3) throw new Error('Use --all, --runtime-only or --legacy-only');
await mkdir(evidenceRoot, { recursive: true });
const runRoot = await mkdtemp(join(evidenceRoot, 'resume-run-'));
const baselineCommit = '1b45abe5dd9cc3404d50da12f8609437793a87df';
const legacySource = execFileSync('git', ['show', `${baselineCommit}:packages/database/src/public-session-repository.ts`],
  { cwd: worktree, windowsHide: true, encoding: 'utf8' });
const legacyModule = join(runRoot, 'baseline-public-session-reader.mjs');
const legacyJs = ts.transpileModule(legacySource, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText;
await writeFile(join(runRoot, 'baseline-public-session-reader.ts'), legacySource);
await writeFile(legacyModule, legacyJs.replaceAll("'@h5cs/domain'", JSON.stringify(pathToFileURL(join(worktree, 'packages/domain/dist/index.js')).href)));
await writeFile(join(runRoot, 'baseline-reader.json'), `${JSON.stringify({ baselineCommit,
  sourcePath: 'packages/database/src/public-session-repository.ts',
  sourceSha256: createHash('sha256').update(legacySource).digest('hex'),
  transformation: 'TypeScript transpilation only; domain import resolves to unchanged worktree domain build' }, null, 2)}\n`);
const results = [];
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
function connectRoot(port) {
  return new Promise((ok, bad) => {
    const client = createConnection({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 500 });
    const timeout = setTimeout(() => { client.destroy(); bad(new Error('Local fixture connection timed out')); }, 1500);
    client.once('connect', () => { clearTimeout(timeout); ok(client.promise()); });
    client.once('error', error => { clearTimeout(timeout); client.destroy(); bad(error); });
  });
}
async function freePort() {
  const server = createServer(); await new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port; await new Promise(ok => server.close(ok)); return port;
}
async function command(executable, args, filename, env = process.env) {
  const stream = createWriteStream(filename, { flags: 'wx' });
  const child = spawn(executable, args, { cwd: packageRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const exitCode = await new Promise((ok, bad) => { child.once('error', bad); child.once('exit', ok); });
  await new Promise(ok => stream.end(ok));
  if (exitCode !== 0) throw new Error(`Isolated test command failed (${exitCode}); see ${filename}`);
}
async function runIsolated(kind) {
  const directory = join(runRoot, kind); await mkdir(directory);
  const datadir = join(directory, 'data'); await mkdir(datadir);
  await command(binary, ['--no-defaults', '--initialize-insecure', `--basedir=${basedir}`, `--datadir=${datadir}`, '--console'], join(directory, 'initialize.log'));
  const port = await freePort();
  const serverLog = createWriteStream(join(directory, 'server-console.log'), { flags: 'wx' });
  const server = spawn(binary, ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--bind-address=127.0.0.1',
    `--port=${port}`, '--mysqlx=0', '--innodb-buffer-pool-size=64M', '--max-connections=16', '--performance-schema=OFF',
    '--innodb-redo-log-capacity=64M', `--pid-file=${join(directory, 'mysqld.pid')}`, '--console'],
    { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(serverLog, { end: false }); server.stderr.pipe(serverLog, { end: false });
  let spawnFailure;
  server.once('error', error => { spawnFailure = error; });
  const result = { kind, bind: '127.0.0.1', port, datadir, serverPid: server.pid,
    checksPassed: false, normalShutdown: false, exitCode: null, forcedCleanup: false };
  results.push(result);
  await writeFile(join(directory, 'instance.json'), `${JSON.stringify(result, null, 2)}\n`);
  let root;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (spawnFailure || server.exitCode !== null || server.signalCode !== null) throw new Error('Isolated mysqld exited; see server-console.log');
      try { root = await connectRoot(port); break; }
      catch { await delay(250); }
    }
    if (!root) throw new Error('Isolated mysqld readiness timed out');
    const password = `local-fixture-${randomBytes(16).toString('hex')}`;
    await root.query(`CREATE DATABASE h5cs_integration_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    // CREATE USER does not accept server-side prepared placeholders. mysql2's
    // query formatter safely quotes this generated, local-only fixture secret.
    await root.query(`CREATE USER 'h5cs_ci'@'127.0.0.1' IDENTIFIED BY ?`, [password]);
    await root.query(`GRANT ALL ON h5cs_integration_ci.* TO 'h5cs_ci'@'127.0.0.1'`);
    const environment = { ...process.env, CI: 'true', NODE_ENV: 'test', APP_ENV: 'test', RAYON_NUM_THREADS: '1',
      H5CS_TEST_LEGACY_PUBLIC_READER: legacyModule,
      H5CS_INTEGRATION_MYSQL_URL: `mysql://h5cs_ci:${password}@127.0.0.1:${port}/h5cs_integration_ci` };
    if (kind === 'legacy-upgrade') {
      await command(process.execPath, ['scripts/verify-ci-upgrade.mjs', '--run'], join(directory, 'upgrade.json.log'), environment);
    } else {
      await command(process.execPath, ['scripts/verify-runtime-stage1-upgrade.mjs'], join(directory, 'upgrade.json.log'), environment);
      await command(process.execPath, ['--test', '--test-concurrency=1', 'test/runtime-stage1.mysql.mjs'], join(directory, 'runtime-tests.tap'), environment);
    }
    result.checksPassed = true;
  } finally {
    let shutdownFailure;
    if (root) {
      try { await root.query({ sql: 'SHUTDOWN', timeout: 5000 }); }
      catch (error) { if (!['PROTOCOL_CONNECTION_LOST', 'ECONNRESET'].includes(error.code)) shutdownFailure = error; }
      root.destroy();
    }
    for (let wait = 0; server.exitCode === null && server.signalCode === null && wait < 100; wait++) await delay(100);
    result.exitCode = server.exitCode;
    result.normalShutdown = Boolean(root) && !shutdownFailure && server.exitCode === 0;
    if (!result.normalShutdown && server.exitCode === null && server.signalCode === null) {
      // Own child handle only; never enumerate or kill any existing MySQL.
      result.forcedCleanup = true;
      server.kill();
      for (let wait = 0; server.exitCode === null && server.signalCode === null && wait < 100; wait++) await delay(100);
    }
    // Preserve logs and the entire isolated datadir, including failed runs.
    await new Promise(ok => serverLog.end(ok));
    await writeFile(join(directory, 'instance.json'), `${JSON.stringify(result, null, 2)}\n`);
    if (!result.normalShutdown) throw new Error('Isolated mysqld did not confirm normal shutdown; inspect retained evidence');
  }
}
let failure;
try {
  if (mode !== '--runtime-only') await runIsolated('legacy-upgrade');
  if (mode !== '--legacy-only') await runIsolated('runtime-stage1');
} catch (error) { failure = error; }
await writeFile(join(runRoot, 'result.json'), `${JSON.stringify({ runRoot, results, passed: !failure,
  error: failure?.message ?? null, productionAccess: false, supplierCalled: false }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ runRoot, passed: !failure, checks: results.length })}\n`);
if (failure) { process.stderr.write(`${failure.message}\n`); process.exitCode = 1; }
