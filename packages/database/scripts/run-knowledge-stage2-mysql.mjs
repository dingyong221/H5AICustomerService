import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2';
import { prepareStage2Baseline, stage2Baseline } from './prepare-knowledge-stage2-baseline.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url)),
  worktree = resolve(packageRoot, '../..');
const stage3 = process.argv.length === 3 && process.argv[2] === '--runtime-stage3';
const authoring = stage3 || (process.argv.length === 3 && process.argv[2] === '--authoring');
const evidenceRoot = resolve(
  worktree,
  `../../../artifacts/agent-work/${stage3 ? 'WI-20261117-008' : authoring ? 'WI-20261117-004' : 'WI-20261116-005'}/local-mysql`,
);
const binary =
  process.env.H5CS_TEST_MYSQLD ??
  'F:/WorkStation/CODEX/implementations/ai-supermarket/H5AICustomerService/artifacts/ai-supermarket-a6/mysql-runtime/mysql-8.4.13-winx64/bin/mysqld.exe';
if (!authoring && process.argv.length !== 2)
  throw Error(
    'Only optional --authoring is accepted; this runner owns a new synthetic local instance',
  );
const basedir = resolve(dirname(binary), '..');
await mkdir(evidenceRoot, { recursive: true });
const runRoot = await mkdtemp(join(evidenceRoot, 'stage2-'));
const baseline = stage2Baseline;
const { legacyModule, baselineMigrations } = await prepareStage2Baseline(runRoot);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function command(executable, args, file, env = process.env) {
  const log = createWriteStream(file, { flags: 'wx' }),
    child = spawn(executable, args, {
      cwd: packageRoot,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise((ok, bad) => {
    child.once('error', bad);
    child.once('close', ok);
  });
  await new Promise((ok) => log.end(ok));
  if (code !== 0) throw Error(`Local test command failed (${code}); see ${file}`);
}
async function freePort() {
  const s = createServer();
  await new Promise((ok, bad) => {
    s.once('error', bad);
    s.listen(0, '127.0.0.1', ok);
  });
  const port = s.address().port;
  await new Promise((ok) => s.close(ok));
  return port;
}
function connectRoot(port) {
  return new Promise((ok, bad) => {
    const c = createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
      password: '',
      connectTimeout: 500,
    });
    const timer = setTimeout(() => {
      c.destroy();
      bad(Error('Local connection timeout'));
    }, 1500);
    c.once('connect', () => {
      clearTimeout(timer);
      ok(c.promise());
    });
    c.once('error', (e) => {
      clearTimeout(timer);
      c.destroy();
      bad(e);
    });
  });
}
const datadir = join(runRoot, 'data');
await mkdir(datadir);
const result = {
  runRoot,
  baseline,
  bind: '127.0.0.1',
  datadir,
  passed: false,
  normalShutdown: false,
  forcedCleanup: false,
  productionAccess: false,
  supplierCalled: false,
};
let server,
  serverLog,
  root,
  failure,
  verifiedOwnership = false;
try {
  await command(
    binary,
    [
      '--no-defaults',
      '--initialize-insecure',
      `--basedir=${basedir}`,
      `--datadir=${datadir}`,
      '--console',
    ],
    join(runRoot, 'initialize.log'),
  );
  const port = await freePort();
  result.port = port;
  serverLog = createWriteStream(join(runRoot, 'server.log'), { flags: 'wx' });
  server = spawn(
    binary,
    [
      '--no-defaults',
      `--basedir=${basedir}`,
      `--datadir=${datadir}`,
      '--bind-address=127.0.0.1',
      `--port=${port}`,
      '--mysqlx=0',
      '--innodb-buffer-pool-size=64M',
      '--max-connections=32',
      '--performance-schema=OFF',
      '--innodb-redo-log-capacity=64M',
      `--pid-file=${join(runRoot, 'mysqld.pid')}`,
      '--console',
    ],
    { cwd: runRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  result.serverPid = server.pid;
  let spawnFailure;
  server.once('error', (e) => {
    spawnFailure = e;
  });
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  for (let i = 0; i < 60; i++) {
    if (spawnFailure || server.exitCode !== null || server.signalCode !== null)
      throw Error('Owned mysqld exited before ready');
    try {
      root = await connectRoot(port);
      break;
    } catch {
      await delay(250);
    }
  }
  if (!root) throw Error('Owned mysqld readiness timed out');
  const [[identity]] = await root.query('SELECT @@datadir datadir,@@version version');
  if (resolve(identity.datadir).toLowerCase() !== resolve(datadir).toLowerCase())
    throw Error('Refused connection: datadir does not match owned instance');
  verifiedOwnership = true;
  result.mysqlVersion = identity.version;
  const password = randomBytes(24).toString('hex');
  await root.query(
    'CREATE DATABASE h5cs_stage2_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  );
  await root.query("CREATE USER 'h5cs_stage2'@'127.0.0.1' IDENTIFIED BY ?", [password]);
  await root.query("GRANT ALL ON h5cs_stage2_ci.* TO 'h5cs_stage2'@'127.0.0.1'");
  await command(
    process.execPath,
    stage3
      ? ['scripts/run-runtime-stage3-ci.mjs']
      : ['scripts/run-knowledge-stage2-ci.mjs', ...(authoring ? ['--authoring'] : [])],
    join(runRoot, 'tests.tap'),
    {
      ...process.env,
      CI: 'true',
      APP_ENV: 'test',
      NODE_ENV: 'test',
      RUNTIME_EXECUTION_CONTROL_ENABLED: 'false',
      H5CS_STAGE2_MYSQL_URL: `mysql://h5cs_stage2:${password}@127.0.0.1:${port}/h5cs_stage2_ci`,
      H5CS_STAGE2_BASELINE_MIGRATIONS: baselineMigrations,
      H5CS_STAGE2_LEGACY_READER: legacyModule,
    },
  );
  // A second empty synthetic database exercises the existing consumer recovery
  // and migration checks unchanged, with the new additive migration present.
  const regressionPassword = randomBytes(24).toString('hex');
  await root.query(
    'CREATE DATABASE h5cs_integration_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  );
  await root.query("CREATE USER 'h5cs_ci'@'127.0.0.1' IDENTIFIED BY ?", [regressionPassword]);
  await root.query("GRANT ALL ON h5cs_integration_ci.* TO 'h5cs_ci'@'127.0.0.1'");
  const regressionEnvironment = {
    ...process.env,
    CI: 'true',
    APP_ENV: 'test',
    NODE_ENV: 'test',
    RUNTIME_EXECUTION_CONTROL_ENABLED: 'false',
    H5CS_TEST_LEGACY_PUBLIC_READER: legacyModule,
    H5CS_INTEGRATION_MYSQL_URL: `mysql://h5cs_ci:${regressionPassword}@127.0.0.1:${port}/h5cs_integration_ci`,
  };
  await command(
    process.execPath,
    ['scripts/verify-runtime-stage1-upgrade.mjs'],
    join(runRoot, 'consumer-upgrade.log'),
    regressionEnvironment,
  );
  await command(
    process.execPath,
    ['--test', '--test-concurrency=1', 'test/runtime-stage1.mysql.mjs'],
    join(runRoot, 'consumer-regression.tap'),
    regressionEnvironment,
  );
  if (authoring) {
    // The synchronous preview CAS contract also affects the existing governance
    // and single-assistant fixtures. Exercise them on this same owned test DB.
    await command(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        'test/publication-governance.mysql.mjs',
        'test/single-assistant-context.mysql.mjs',
      ],
      join(runRoot, 'preview-compatibility.tap'),
      regressionEnvironment,
    );
  }
  result.passed = true;
} catch (e) {
  failure = e;
} finally {
  if (root && verifiedOwnership) {
    try {
      await root.query({ sql: 'SHUTDOWN', timeout: 5000 });
    } catch (e) {
      if (!['PROTOCOL_CONNECTION_LOST', 'ECONNRESET'].includes(e.code))
        failure ??= Error('Owned instance shutdown failed');
    }
  }
  root?.destroy();
  if (server) {
    for (let i = 0; i < 100 && server.exitCode === null && server.signalCode === null; i++)
      await delay(100);
    result.normalShutdown = verifiedOwnership && server.exitCode === 0;
    result.exitCode = server.exitCode;
    if (server.exitCode === null && server.signalCode === null) {
      result.forcedCleanup = true;
      server.kill();
      for (let i = 0; i < 100 && server.exitCode === null && server.signalCode === null; i++)
        await delay(100);
    }
    if (!result.normalShutdown) failure ??= Error('Normal shutdown not confirmed');
  }
  if (serverLog) await new Promise((ok) => serverLog.end(ok));
  result.passed = result.passed && !failure;
  result.error = failure?.message ?? null;
  await writeFile(join(runRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
process.stdout.write(
  JSON.stringify({ runRoot, passed: result.passed, normalShutdown: result.normalShutdown }) + '\n',
);
if (failure) {
  process.stderr.write(failure.message + '\n');
  process.exitCode = 1;
}
