import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createConnection as connectTcp } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import {
  seedBaselineData,
  snapshotTables,
} from '../../packages/database/scripts/verify-ci-upgrade.mjs';

if (
  process.argv.slice(2).join(' ') !== '--run' ||
  process.env.NODE_ENV !== 'test' ||
  process.env.APP_ENV !== 'test'
)
  throw new Error('Explicit local test environment and --run required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requireDb = createRequire(new URL('../../packages/database/package.json', import.meta.url));
const { createConnection } = requireDb('mysql2/promise');
const { drizzle } = requireDb('drizzle-orm/mysql2');
const { migrate } = requireDb('drizzle-orm/mysql2/migrator');
const evidence = join(
  root,
  'artifacts/business-ux-governance-20261024/integration',
  `run-${Date.now()}`,
);
await mkdir(evidence, { recursive: true });
// Preserve generated databases outside the nearly full source volume. No existing
// database directory is opened, reused or deleted by this runner.
const localDataRoot = 'D:/H5AI-local-verification/20261024/mysql';
const mysqlBase =
  'F:/WorkStation/CODEX/implementations/ai-supermarket/H5AICustomerService/artifacts/ai-supermarket-a6/mysql-runtime/mysql-8.4.13-winx64';
const password = randomBytes(24).toString('base64url');
const phoneKey = randomBytes(32).toString('base64url');
const modelKey = 'local-fixture-' + randomBytes(32).toString('base64url');
const previewToken = randomBytes(32).toString('base64url');
const secretValues = [password, phoneKey, modelKey, previewToken];
const sanitize = (value) =>
  secretValues.reduce(
    (text, secret) => text.replaceAll(secret, '[LOCAL_TEST_REDACTED]'),
    String(value),
  );
const hash = (value) => createHash('sha256').update(value).digest('hex');
const ports = [3000, 3001, 3003, 3011, 4000, 9020, 33188, 33189];
async function listening(port) {
  return new Promise((done) => {
    const socket = connectTcp({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      done(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  USERPROFILE: process.env.USERPROFILE,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  NODE_ENV: 'test',
  APP_ENV: 'test',
  NEXT_TELEMETRY_DISABLED: '1',
  MYSQL_DATABASE_URL: `mysql://h5cs_ci:${password}@127.0.0.1:33188/h5cs_integration_ci`,
  H5CS_INTEGRATION_MYSQL_URL: `mysql://h5cs_ci:${password}@127.0.0.1:33188/h5cs_integration_ci`,
  MERCHANT_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
  MERCHANT_PHONE_LOOKUP_KEY: phoneKey,
  PUBLIC_CONVERSATION_ENABLED: 'true',
  CONSUMER_H5_ORIGIN: 'http://127.0.0.1:3001',
  CONVERSATION_WORKER_ENABLED: 'true',
  MODEL_PROVIDER: 'chat_completions',
  MODEL_NAME: 'local-deterministic-governance',
  MODEL_API_KEY: modelKey,
  MODEL_CHAT_COMPLETIONS_URL: 'http://127.0.0.1:9020/chat/completions',
  PREVIEW_AUTH_TOKEN: previewToken,
  H5CS_E2E_MODEL_KEY: modelKey,
  PUBLISH_PROMPT_TEMPLATE_VERSION: 'governance-local-v1',
  PUBLISH_RETRIEVAL_POLICY_VERSION: 'governance-local-v1',
  PUBLISH_MODEL_POLICY_VERSION: 'governance-local-v1',
  API_READINESS_URL: 'http://127.0.0.1:4000/readyz',
  WORKER_READINESS_URL: 'http://127.0.0.1:3011/readyz',
  H5CS_GOV_EVIDENCE: evidence,
  H5CS_GOV_BROWSER_EXECUTABLE: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
};
// Deliberately do not inherit production DB, model/file key, CA, SSH or cloud settings.
const children = [];
function launch(name, command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, env, ...options });
  let output = JSON.stringify({ name, startedAt: new Date().toISOString() }) + '\n';
  let writes = Promise.resolve();
  const flush = () => {
    writes = writes.then(() => writeFile(join(evidence, name + '.log'), sanitize(output)));
  };
  flush();
  const record = { name, child, done: null };
  record.done = new Promise((resolveDone, reject) => {
    child.on('error', reject);
    child.on('close', async (code, signal) => {
      output += '\n' + JSON.stringify({ exitedAt: new Date().toISOString(), code, signal });
      flush();
      await writes;
      code === 0
        ? resolveDone()
        : reject(new Error(`${name} failed (${code}); inspect redacted log`));
    });
  });
  record.done.catch(() => {});
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (data) => {
      output += data.toString();
      flush();
    });
  children.push(record);
  void writeFile(
    join(evidence, 'process-manifest.json'),
    JSON.stringify(
      children.map((item) => ({ name: item.name, pid: item.child.pid })),
      null,
      2,
    ),
  );
  return record;
}
const node = (name, args, options) => launch(name, process.execPath, args, options);
async function waitHttp(url) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('Local service not ready: ' + url);
}
async function startMysql(name, port) {
  const data = join(localDataRoot, basename(evidence), name);
  await mkdir(dirname(data), { recursive: true });
  await mkdir(data);
  await writeFile(join(evidence, name + '-data-location.txt'), data);
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
  for (let attempt = 0; attempt < 90; attempt++) {
    let connection;
    try {
      connection = await createConnection({
        host: '127.0.0.1',
        port,
        user: 'root',
        password: '',
        timezone: 'Z',
        dateStrings: true,
      });
    } catch {}
    if (connection) {
      const [rows] = await connection.query('SELECT @@datadir data_dir');
      if (resolve(rows[0].data_dir).toLowerCase() !== resolve(data).toLowerCase()) {
        await connection.end();
        throw new Error('Refusing a different MySQL instance');
      }
      await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [password]);
      return connection;
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error('Dedicated local MySQL did not start');
}
async function tables(connection) {
  const [rows] = await connection.query(
    'SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME',
  );
  return rows.map((row) => row.name);
}
async function sourceManifest() {
  const { stdout } = await promisify(execFile)(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, maxBuffer: 5_000_000, windowsHide: true },
  );
  const files = [
    ...new Set(
      stdout
        .split('\0')
        .filter(
          (file) =>
            file &&
            !file.startsWith('docs/') &&
            !file.startsWith('artifacts/') &&
            !file.endsWith('.md'),
        ),
    ),
  ].sort();
  const entries = [];
  for (const file of files)
    entries.push({ path: file, sha256: hash(await readFile(join(root, file))) });
  return { entries, entriesJsonSha256: hash(JSON.stringify(entries)) };
}
let source, restore;
const report = {
  kind: 'business-ux-local-integration',
  paidSupplierCalls: 0,
  productionTouched: false,
};
try {
  for (const port of ports)
    if (await listening(port))
      throw new Error('A required local test port is already occupied: ' + port);
  const manifest = await sourceManifest();
  const manifestFile = JSON.stringify(manifest, null, 2);
  await writeFile(join(evidence, 'source-before.json'), manifestFile);
  report.source = {
    files: manifest.entries.length,
    entriesJsonSha256: manifest.entriesJsonSha256,
    manifestFileSha256: hash(manifestFile),
  };
  source = await startMysql('source', 33188);
  await source.query(
    'CREATE DATABASE h5cs_integration_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
  );
  await source.query("CREATE USER 'h5cs_ci'@'127.0.0.1' IDENTIFIED BY ?", [password]);
  await source.query("GRANT ALL ON h5cs_integration_ci.* TO 'h5cs_ci'@'127.0.0.1'");
  await source.query('USE h5cs_integration_ci');
  const folder = join(root, 'packages/database/migrations');
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  if (journal.entries.length <= 13) throw new Error('Governance migration is not present');
  const baseline = join(evidence, 'baseline13');
  await mkdir(join(baseline, 'meta'), { recursive: true });
  for (const entry of journal.entries.slice(0, 13))
    await copyFile(join(folder, entry.tag + '.sql'), join(baseline, entry.tag + '.sql'));
  await writeFile(
    join(baseline, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 13) }),
  );
  await migrate(drizzle(source), { migrationsFolder: baseline });
  await seedBaselineData(source);
  const legacyTables = (await tables(source)).filter((table) => table !== '__drizzle_migrations');
  const before = await snapshotTables(source, legacyTables);
  const originalRows = {};
  for (const table of legacyTables) {
    const [rows] = await source.query('SELECT * FROM `' + table + '`');
    originalRows[table] = rows.map((row) => JSON.stringify(row));
  }
  await migrate(drizzle(source), { migrationsFolder: folder });
  await migrate(drizzle(source), { migrationsFolder: folder });
  if ((await snapshotTables(source, legacyTables)).sha256 !== before.sha256)
    throw new Error('Upgrade/replay changed legacy rows');
  report.upgrade = {
    from: 13,
    to: journal.entries.length,
    legacyTables: legacyTables.length,
    preserved: true,
    sha256: before.sha256,
  };

  await node('governance-mysql', [
    '--test',
    'packages/database/test/publication-governance.mysql.mjs',
  ]).done;
  await node(
    'existing-api-mysql',
    ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts'],
    { cwd: join(root, 'apps/api') },
  ).done;
  const db = await import('../../packages/database/dist/index.js');
  const database = db.loadDatabaseConfig(env);
  if (!database.configured) throw new Error('Local application database config rejected');
  const fixtures = [];
  for (const device of ['desktop', 'mobile']) {
    const merchant = await new db.MySqlPlatformProvisioningRepository(
      database.config,
    ).provisionMerchant({
      name: '本地业务治理验收 ' + device,
      operatorId: 'local_governance_test',
    });
    const fixture = {
      device,
      phone: '136' + String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0'),
      password: randomBytes(24).toString('base64url'),
      merchantId: merchant.id,
    };
    secretValues.push(fixture.password, merchant.setupToken);
    await new db.MySqlMerchantAccessRepository(database.config, phoneKey).claimInvitation({
      setupToken: merchant.setupToken,
      phone: fixture.phone,
      password: fixture.password,
    });
    fixtures.push(fixture);
  }
  env.H5CS_GOV_FIXTURES = JSON.stringify(fixtures);
  node('fake-model', ['tests/governance/fake-model.mjs']);
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
  for (const [app, port] of [
    ['merchant-web', 3000],
    ['consumer-h5', 3003],
  ]) {
    const requireApp = createRequire(join(root, 'apps', app, 'package.json'));
    node(
      app,
      [
        requireApp.resolve('next/dist/bin/next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      { cwd: join(root, 'apps', app) },
    );
    await waitHttp(
      `http://127.0.0.1:${port}${app === 'merchant-web' ? '/console/account/login' : '/'}`,
    );
  }
  node('gateway', ['tests/e2e/public-gateway.mjs'], {
    env: { ...env, H5CS_E2E_PATH_MODE: 'root' },
  });
  await waitHttp('http://127.0.0.1:3001/_gateway-health');
  await node('browser', [
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'playwright.governance.config.ts',
  ]).done;
  for (const table of legacyTables) {
    const [rows] = await source.query('SELECT * FROM `' + table + '`');
    const current = new Set(rows.map((row) => JSON.stringify(row)));
    if (!originalRows[table].every((row) => current.has(row)))
      throw new Error('A legacy business row changed: ' + table);
  }
  report.upgrade.originalRowsPreservedAfterBrowser = true;
  report.localModel = await (await fetch('http://127.0.0.1:9020/healthz')).json();
  const fullBefore = await snapshotTables(source, await tables(source));
  const backup = join(evidence, 'full-backup.sql.gz');
  const dump = launch(
    'dump',
    join(mysqlBase, 'bin/mysqldump.exe'),
    [
      '--no-defaults',
      '--host=127.0.0.1',
      '--port=33188',
      '--user=root',
      '--single-transaction',
      '--set-gtid-purged=OFF',
      '--no-tablespaces',
      '--routines',
      '--events',
      '--triggers',
      '--hex-blob',
      '--databases',
      'h5cs_integration_ci',
    ],
    { env: { ...env, MYSQL_PWD: password } },
  );
  dump.child.stdout.removeAllListeners('data');
  await Promise.all([
    pipeline(dump.child.stdout, createGzip(), createWriteStream(backup)),
    dump.done,
  ]);
  restore = await startMysql('restore', 33189);
  const importer = launch(
    'restore-import',
    join(mysqlBase, 'bin/mysql.exe'),
    ['--no-defaults', '--host=127.0.0.1', '--port=33189', '--user=root', '--binary-mode'],
    { env: { ...env, MYSQL_PWD: password } },
  );
  await Promise.all([
    pipeline(createReadStream(backup), createGunzip(), importer.child.stdin),
    importer.done,
  ]);
  await restore.query('USE h5cs_integration_ci');
  const restored = await snapshotTables(restore, await tables(restore));
  if (restored.sha256 !== fullBefore.sha256)
    throw new Error('Independent restore fingerprint mismatch');
  report.restore = {
    tables: restored.tables.length,
    sourceSha256: fullBefore.sha256,
    restoredSha256: restored.sha256,
    backupSha256: hash(await readFile(backup)),
    equal: true,
  };
  if ((await sourceManifest()).entriesJsonSha256 !== manifest.entriesJsonSha256)
    throw new Error('Source changed during integration run; rerun the affected tests');
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({ passed: true, evidence, upgrade: report.upgrade, restore: report.restore }) +
      '\n',
  );
} catch (error) {
  await writeFile(join(evidence, 'failure.txt'), sanitize(error.stack ?? error));
  process.stderr.write(sanitize(error.message) + '\n');
  process.exitCode = 1;
} finally {
  for (const connection of [source, restore])
    if (connection) {
      await connection.query('SHUTDOWN').catch(() => {});
      await connection.end().catch(() => {});
    }
  for (const record of children.reverse())
    if (record.child.exitCode === null && !record.child.killed) {
      if (process.platform === 'win32')
        await promisify(execFile)('taskkill.exe', ['/PID', String(record.child.pid), '/T', '/F'], {
          windowsHide: true,
        }).catch(() => {});
      else record.child.kill('SIGTERM');
    }
  await Promise.race([
    Promise.all(children.map((record) => record.done.catch(() => {}))),
    new Promise((done) => setTimeout(done, 5000)),
  ]);
  const occupied = [];
  for (const port of ports) if (await listening(port)) occupied.push(port);
  const stopped = occupied.length === 0;
  await writeFile(
    join(evidence, 'processes-stopped.json'),
    JSON.stringify({ stopped, observedListeners: occupied, productionTouched: false }),
  );
  if (!stopped) process.exitCode = 1;
}
