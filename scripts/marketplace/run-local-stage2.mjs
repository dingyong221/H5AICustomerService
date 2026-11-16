import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { legacyRowJson } from './legacy-row-projection.mjs';
const databaseRequire = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
);
const { createConnection } = databaseRequire('mysql2/promise');
const { drizzle } = databaseRequire('drizzle-orm/mysql2');
const { migrate } = databaseRequire('drizzle-orm/mysql2/migrator');
import {
  seedBaselineData,
  snapshotTables,
} from '../../packages/database/scripts/verify-ci-upgrade.mjs';

if (
  process.argv.slice(2).join(' ') !== '--run' ||
  process.env.NODE_ENV !== 'test' ||
  process.env.APP_ENV !== 'test'
)
  throw new Error('Use test/local isolated stage2 --run only');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerMode = process.env.H5CS_A6_RUNTIME === 'docker-ci';
if (dockerMode && (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true'))
  throw Error('Docker mode is restricted to a disposable GitHub Actions runner');
const runId = 'h5cs-free-' + Date.now();
const dockerNames = {};
const evidence = join(root, 'artifacts/ai-supermarket-a6-stage2', `run-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const mysqlBase =
  process.env.H5CS_A6_MYSQL_HOME ??
  'F:/WorkStation/CODEX/implementations/ai-supermarket/H5AICustomerService/artifacts/ai-supermarket-a6/mysql-runtime/mysql-8.4.13-winx64';
const password = randomBytes(24).toString('base64url'),
  phoneKey = randomBytes(32).toString('base64url');
const modelKey = 'local-fixture-' + randomBytes(32).toString('base64url'),
  previewToken = randomBytes(32).toString('base64url');
const secrets = [password, phoneKey, modelKey, previewToken];
const sanitize = (text) =>
  secrets.reduce((value, secret) => value.replaceAll(secret, '[LOCAL_TEST_REDACTED]'), text);
const children = [];
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  USERPROFILE: process.env.USERPROFILE,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  NODE_ENV: 'test',
  NODE_OPTIONS: '--max-old-space-size=256 --max-semi-space-size=4',
  UV_THREADPOOL_SIZE: '1',
  APP_ENV: 'test',
  H5CS_MARKETPLACE_MODE: 'public-free',
  H5CS_GROWTH_USAGE_ENABLED: 'true',
  H5CS_FREE_CAMPAIGN: 'h5-local-' + Date.now(),
  H5CS_FREE_DAYS: 'unlimited',
  H5CS_FREE_MODEL_CALLS: 'unlimited',
  H5CS_FREE_MAX_CLAIMS: 'unlimited',
  MYSQL_DATABASE_URL: `mysql://h5cs_a6_test:${password}@127.0.0.1:33186/h5cs_marketplace_a6_test`,
  MERCHANT_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
  OPS_PUBLIC_ORIGIN: 'http://127.0.0.1:3002',
  NEXT_PUBLIC_OPS_BASE_PATH: '/ops',
  OPS_ADMIN_USERNAME: 'local-growth-operator',
  OPS_ADMIN_PASSWORD_HASH: 'local-unused-password-hash',
  OPS_SESSION_SIGNING_KEY: phoneKey,
  MERCHANT_PHONE_LOOKUP_KEY: phoneKey,
  PUBLIC_CONVERSATION_ENABLED: 'true',
  CONSUMER_H5_ORIGIN: 'http://127.0.0.1:3001',
  CONVERSATION_WORKER_ENABLED: 'true',
  MODEL_PROVIDER: 'chat_completions',
  MODEL_NAME: 'local-deterministic-fixture',
  MODEL_API_KEY: modelKey,
  MODEL_CHAT_COMPLETIONS_URL: 'http://127.0.0.1:9020/chat/completions',
  PREVIEW_AUTH_TOKEN: previewToken,
  PUBLISH_PROMPT_TEMPLATE_VERSION: 'a6-local-v1',
  PUBLISH_RETRIEVAL_POLICY_VERSION: 'a6-local-v1',
  PUBLISH_MODEL_POLICY_VERSION: 'a6-local-v1',
  API_READINESS_URL: 'http://127.0.0.1:4000/readyz',
  WORKER_READINESS_URL: 'http://127.0.0.1:3011/readyz',
  H5CS_A6_EVIDENCE: evidence,
  H5CS_A6_BROWSER_EXECUTABLE: process.env.H5CS_A6_BROWSER_EXECUTABLE,
  NEXT_PUBLIC_PUBLIC_API_BASE_URL: '/api/v1/public',
  H5CS_LOCAL_MODEL_FIXTURE: 'true',
  NEXT_TELEMETRY_DISABLED: '1',
};
// Never inherit a real supplier/file key or production TLS setting into local fixtures.
for (const key of [
  'MODEL_API_KEY_FILE',
  'PREVIEW_AUTH_TOKEN_FILE',
  'MYSQL_TLS_CA_FILE',
  'NEXT_PUBLIC_MERCHANT_BASE_PATH',
])
  delete env[key];
function launch(name, executable, args, extra = {}) {
  const child = spawn(executable, args, { cwd: root, windowsHide: true, env, ...extra });
  const record = { name, child, output: '', done: null };
  record.done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', async (code) => {
      await writeFile(join(evidence, name + '.log'), sanitize(record.output));
      code === 0
        ? resolve()
        : reject(new Error(`${name} failed (${code}); inspect its redacted log`));
    });
  });
  record.done.catch(() => {});
  const recordOutput = (d) => {
    record.output += d;
    writeFileSync(join(evidence, name + '.log'), sanitize(record.output));
  };
  child.stdout?.on('data', recordOutput);
  child.stderr?.on('data', recordOutput);
  children.push(record);
  writeFileSync(
    join(evidence, 'process-manifest.json'),
    JSON.stringify(
      children.map((r) => ({ name: r.name, pid: r.child.pid })),
      null,
      2,
    ),
  );
  return record;
}
const node = (name, args, extra) => launch(name, process.execPath, args, extra);
async function waitHttp(url) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error(`Local service readiness failed: ${url}`);
}
async function waitMysql(port, pwd) {
  for (let i = 0; i < 180; i++) {
    try {
      return await createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        password: pwd,
        timezone: 'Z',
        dateStrings: true,
      });
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error('Local MySQL readiness failed');
}
async function startMysql(name, port) {
  if (dockerMode) {
    const container = `${runId}-${name}`;
    dockerNames[name] = container;
    launch(
      name + '-server',
      'docker',
      [
        'run',
        '--rm',
        '--name',
        container,
        '--label',
        `h5cs.test.run=${runId}`,
        '-p',
        `127.0.0.1:${port}:3306`,
        '-e',
        'MYSQL_ROOT_PASSWORD',
        '-e',
        'MYSQL_ROOT_HOST',
        'mysql:8.4.13',
        '--mysqlx=OFF',
        '--skip-log-bin',
        '--innodb-buffer-pool-size=64M',
      ],
      { env: { ...env, MYSQL_ROOT_PASSWORD: password, MYSQL_ROOT_HOST: '%' } },
    );
    const c = await waitMysql(port, password);
    const [version] = await c.query('SELECT VERSION() version');
    if (!/^8\.4\./u.test(version[0].version)) throw Error('Disposable MySQL 8.4 required');
    return c;
  }
  const data = join(evidence, name);
  await mkdir(data);
  await launch(name + '-init', join(mysqlBase, 'bin/mysqld.exe'), [
    '--no-defaults',
    `--basedir=${mysqlBase}`,
    `--datadir=${data}`,
    '--initialize-insecure',
    '--console',
  ]).done;
  launch(name + '-server', join(mysqlBase, 'bin/mysqld.exe'), [
    '--no-defaults',
    `--basedir=${mysqlBase}`,
    `--datadir=${data}`,
    '--bind-address=127.0.0.1',
    `--port=${port}`,
    '--mysqlx=OFF',
    '--skip-log-bin',
    '--innodb-buffer-pool-size=64M',
    '--console',
  ]);
  const c = await waitMysql(port, '');
  const [ownership] = await c.query('SELECT @@datadir data_dir');
  if (resolve(ownership[0].data_dir).toLowerCase() !== resolve(data).toLowerCase()) {
    await c.end();
    throw Error('Refusing a different local MySQL data directory');
  }
  await c.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [password]);
  return c;
}
async function tables(c) {
  const [rows] = await c.query(
    'SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME',
  );
  return rows.map((r) => r.name);
}
const report = { kind: 'a6-local-stage2', externalMarketplace: false, paidSupplierCalls: 0 };
let source, restore;
try {
  for (const port of [33186, 33187, 3000, 3001, 3003, 3011, 4000, 9020]) {
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once('error', () => reject(Error(`Refusing occupied local test port ${port}`)));
      probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
  }
  source = await startMysql('source', 33186);
  await source.query(
    'CREATE DATABASE h5cs_marketplace_a6_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  );
  await source.query("CREATE USER 'h5cs_a6_test'@'127.0.0.1' IDENTIFIED BY ?", [password]);
  await source.query("GRANT ALL ON h5cs_marketplace_a6_test.* TO 'h5cs_a6_test'@'127.0.0.1'");
  if (dockerMode) {
    await source.query("CREATE USER 'h5cs_a6_test'@'%' IDENTIFIED BY ?", [password]);
    await source.query("GRANT ALL ON h5cs_marketplace_a6_test.* TO 'h5cs_a6_test'@'%'");
  }
  await source.query('USE h5cs_marketplace_a6_test');
  const migrations = join(root, 'packages/database/migrations'),
    baseline = join(evidence, 'baseline13');
  await mkdir(join(baseline, 'meta'), { recursive: true });
  const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8'));
  for (const entry of journal.entries.slice(0, 13))
    await copyFile(join(migrations, entry.tag + '.sql'), join(baseline, entry.tag + '.sql'));
  await writeFile(
    join(baseline, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 13) }),
  );
  await migrate(drizzle(source), { migrationsFolder: baseline });
  await seedBaselineData(source);
  const baseline15 = join(evidence, 'baseline15');
  await mkdir(join(baseline15, 'meta'), { recursive: true });
  for (const e of journal.entries.slice(0, 15))
    await copyFile(join(migrations, e.tag + '.sql'), join(baseline15, e.tag + '.sql'));
  await writeFile(
    join(baseline15, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 15) }),
  );
  await migrate(drizzle(source), { migrationsFolder: baseline15 });
  const legacyTables = (await tables(source)).filter((t) => t !== '__drizzle_migrations');
  const before = await snapshotTables(source, legacyTables, { legacyJobProjection: true });
  const legacyRows = {};
  for (const table of legacyTables) {
    const [rows] = await source.query('SELECT * FROM `' + table + '`');
    legacyRows[table] = rows.map((row) => legacyRowJson(table, row));
  }
  await migrate(drizzle(source), { migrationsFolder: migrations });
  const after = await snapshotTables(source, legacyTables, { legacyJobProjection: true });
  if (before.sha256 !== after.sha256) throw Error('Legacy baseline changed during marketplace DDL');
  report.upgrade = {
    from: 15,
    to: journal.entries.length,
    legacyTables: legacyTables.length,
    legacySha256: before.sha256,
    preserved: true,
  };
  await migrate(drizzle(source), { migrationsFolder: migrations });
  if (
    (await snapshotTables(source, legacyTables, { legacyJobProjection: true })).sha256 !==
    before.sha256
  )
    throw Error('Replay modified legacy rows');
  console.log(`Non-empty 15→${journal.entries.length} migration and replay preserved legacy data`);
  // Also run the existing non-empty CI upgrade probe, beyond its offline unit tests.
  await source.query(
    'CREATE DATABASE h5cs_integration_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  );
  await source.query("CREATE USER 'h5cs_ci'@'127.0.0.1' IDENTIFIED BY ?", [password]);
  await source.query("GRANT ALL ON h5cs_integration_ci.* TO 'h5cs_ci'@'127.0.0.1'");
  if (dockerMode) {
    await source.query("CREATE USER 'h5cs_ci'@'%' IDENTIFIED BY ?", [password]);
    await source.query("GRANT ALL ON h5cs_integration_ci.* TO 'h5cs_ci'@'%'");
  }
  await node('ci-upgrade-probe', ['packages/database/scripts/verify-ci-upgrade.mjs', '--run'], {
    env: {
      ...env,
      CI: 'true',
      H5CS_INTEGRATION_MYSQL_URL: `mysql://h5cs_ci:${password}@127.0.0.1:33186/h5cs_integration_ci`,
    },
  }).done;
  await node('transaction-tests', ['--test', 'scripts/marketplace/marketplace-mysql.test.mjs'], {
    env: { ...env, H5CS_A6_TEST_MYSQL_URL: env.MYSQL_DATABASE_URL },
  }).done;
  await node(
    'public-free-transactions',
    ['--test', 'scripts/marketplace/public-free-mysql.test.mjs'],
    { env: { ...env, H5CS_A6_TEST_MYSQL_URL: env.MYSQL_DATABASE_URL } },
  ).done;
  node('fake-model', ['tests/marketplace/fake-model.mjs'], {
    env: { ...env, H5CS_E2E_MODEL_KEY: modelKey },
  });
  await waitHttp('http://127.0.0.1:9020/healthz');
  node('api', ['apps/api/dist/main.js'], {
    env: {
      ...env,
      HOST: '127.0.0.1',
      PORT: '4000',
      VISITOR_CREDENTIAL_HMAC_KEY: randomBytes(32).toString('base64url'),
    },
  });
  await waitHttp('http://127.0.0.1:4000/readyz');
  node('worker', ['apps/worker/dist/main.js'], {
    env: { ...env, WORKER_HEALTH_HOST: '127.0.0.1', WORKER_POLL_INTERVAL_MS: '200' },
  });
  await waitHttp('http://127.0.0.1:3011/readyz');
  node(
    'merchant',
    [
      join(root, 'apps/merchant-web/node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3000',
    ],
    { cwd: join(root, 'apps/merchant-web') },
  );
  await waitHttp('http://127.0.0.1:3000/console/marketplace');
  node(
    'ops',
    [
      join(root, 'apps/ops-web/node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3002',
    ],
    { cwd: join(root, 'apps/ops-web') },
  );
  await waitHttp('http://127.0.0.1:3002/ops/login');
  node(
    'consumer',
    [
      join(root, 'apps/consumer-h5/node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3003',
    ],
    { cwd: join(root, 'apps/consumer-h5') },
  );
  await waitHttp('http://127.0.0.1:3003/');
  node('gateway', ['tests/e2e/public-gateway.mjs'], {
    env: { ...env, H5CS_E2E_PATH_MODE: 'root' },
  });
  await waitHttp('http://127.0.0.1:3001/_gateway-health');
  await node('browser', [
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.marketplace.config.ts',
  ]).done;
  for (const table of legacyTables) {
    const [rows] = await source.query('SELECT * FROM `' + table + '`');
    const current = new Set(rows.map((row) => legacyRowJson(table, row)));
    if (!legacyRows[table].every((row) => current.has(row)))
      throw Error('Legacy business row changed during browser flow: ' + table);
  }
  report.upgrade.legacyRowsStillPreservedAfterBrowser = true;
  report.localModelFixture = await (await fetch('http://127.0.0.1:9020/healthz')).json();
  const fullBefore = await snapshotTables(source, await tables(source));
  const backup = join(evidence, 'full-backup.sql.gz');
  const dump = launch(
    'dump',
    dockerMode ? 'docker' : join(mysqlBase, 'bin/mysqldump.exe'),
    [
      ...(dockerMode ? ['exec', '-e', 'MYSQL_PWD', dockerNames.source, 'mysqldump'] : []),
      '--no-defaults',
      ...(!dockerMode ? ['--host=127.0.0.1', '--port=33186'] : []),
      '--user=root',
      '--single-transaction',
      '--set-gtid-purged=OFF',
      '--no-tablespaces',
      '--routines',
      '--events',
      '--triggers',
      '--hex-blob',
      '--databases',
      'h5cs_marketplace_a6_test',
    ],
    { env: { ...env, MYSQL_PWD: password } },
  );
  dump.child.stdout.removeAllListeners('data');
  await Promise.all([
    pipeline(dump.child.stdout, createGzip(), createWriteStream(backup)),
    dump.done,
  ]);
  restore = await startMysql('restore', 33187);
  const importer = launch(
    'restore-import',
    dockerMode ? 'docker' : join(mysqlBase, 'bin/mysql.exe'),
    [
      ...(dockerMode ? ['exec', '-i', '-e', 'MYSQL_PWD', dockerNames.restore, 'mysql'] : []),
      '--no-defaults',
      ...(!dockerMode ? ['--host=127.0.0.1', '--port=33187'] : []),
      '--user=root',
      '--binary-mode',
    ],
    { env: { ...env, MYSQL_PWD: password } },
  );
  await Promise.all([
    pipeline(createReadStream(backup), createGunzip(), importer.child.stdin),
    importer.done,
  ]);
  await restore.query('USE h5cs_marketplace_a6_test');
  const restored = await snapshotTables(restore, await tables(restore));
  if (fullBefore.sha256 !== restored.sha256)
    throw Error('Full restore schema/data fingerprint mismatch');
  report.restore = {
    tableCount: restored.tables.length,
    sourceSha256: fullBefore.sha256,
    restoredSha256: restored.sha256,
    backupSha256: createHash('sha256')
      .update(await readFile(backup))
      .digest('hex'),
    equal: true,
  };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ passed: true, evidence, upgrade: report.upgrade, restore: report.restore }),
  );
} catch (error) {
  await writeFile(join(evidence, 'failure.txt'), sanitize(error.stack ?? String(error)));
  console.error(sanitize(error.message));
  process.exitCode = 1;
} finally {
  for (const c of [source, restore])
    if (c) {
      await c.query('SHUTDOWN').catch(() => {});
      await c.end().catch(() => {});
    }
  if (dockerMode) {
    for (const container of Object.values(dockerNames)) {
      // Unique names belong only to this run; never use a global Docker cleanup.
      await launch('stop-' + container, 'docker', ['stop', '--time', '10', container]).done.catch(
        () => {},
      );
    }
  }
  for (const record of children.reverse())
    if (record.child.exitCode === null && !record.child.killed) {
      if (process.platform === 'win32')
        await new Promise((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(record.child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('close', resolve);
        });
      else record.child.kill('SIGTERM');
    }
  await writeFile(
    join(evidence, 'processes-stopped.json'),
    JSON.stringify({
      cleanupAttempted: true,
      stopped: children.every(
        (record) => record.child.exitCode !== null || record.child.signalCode !== null,
      ),
      productionTouched: false,
    }),
  );
}
