import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsFolder = fileURLToPath(new URL('../migrations/', import.meta.url));
const journalFile = fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url));

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export class MigrationPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationPreflightError';
  }
}

export function migrationInventory(folder = migrationsFolder, journalPath = journalFile) {
  const journalBytes = readFileSync(journalPath);
  const journal = JSON.parse(journalBytes.toString('utf8'));
  if (journal?.dialect !== 'mysql' || !Array.isArray(journal.entries)) {
    throw new MigrationPreflightError('MySQL migration journal is invalid');
  }
  const entries = journal.entries.map((entry, index) => {
    if (
      entry?.idx !== index ||
      typeof entry.tag !== 'string' ||
      !/^\d{4}_[A-Za-z0-9_]+$/u.test(entry.tag)
    ) {
      throw new MigrationPreflightError('MySQL migration order is invalid');
    }
    const filename = `${entry.tag}.sql`;
    const bytes = readFileSync(resolve(folder, filename));
    return { tag: entry.tag, sha256: sha256(bytes) };
  });
  const expected = new Set(entries.map((entry) => `${entry.tag}.sql`));
  const actual = readdirSync(folder).filter((name) => name.endsWith('.sql'));
  if (
    expected.size !== entries.length ||
    actual.length !== expected.size ||
    actual.some((name) => !expected.has(name))
  ) {
    throw new MigrationPreflightError('MySQL migration files do not match the journal');
  }
  return {
    dialect: 'mysql',
    entries,
    planSha256: sha256(JSON.stringify({ journalSha256: sha256(journalBytes), entries })),
  };
}

export function parseMigrationArguments(args) {
  if (args.length === 1 && args[0] === '--inventory') return { action: 'inventory' };
  if (!args.includes('--apply')) {
    throw new MigrationPreflightError('Run --inventory first, then use explicit --apply arguments');
  }
  const values = new Map();
  for (const argument of args) {
    if (argument === '--apply') continue;
    const match = /^--(target|expect-host|expect-database|accept-plan-sha256)=(.+)$/u.exec(
      argument,
    );
    if (!match || values.has(match[1]))
      throw new MigrationPreflightError('Migration arguments are invalid');
    values.set(match[1], match[2]);
  }
  if (
    args.length !== 5 ||
    !['staging', 'production'].includes(values.get('target')) ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{1,252}$/u.test(values.get('expect-host') ?? '') ||
    isIP(values.get('expect-host') ?? '') !== 0 ||
    values.get('expect-host') === 'localhost' ||
    !/^[A-Za-z0-9_]{1,64}$/u.test(values.get('expect-database') ?? '') ||
    !/^[0-9a-f]{64}$/u.test(values.get('accept-plan-sha256') ?? '')
  ) {
    throw new MigrationPreflightError(
      'Migration target, expected host/database or plan hash is invalid',
    );
  }
  return {
    action: 'apply',
    target: values.get('target'),
    expectedHost: values.get('expect-host'),
    expectedDatabase: values.get('expect-database'),
    acceptedPlanSha256: values.get('accept-plan-sha256'),
  };
}

export function migrationDatabaseUrl(environment = process.env) {
  const inline = environment.MYSQL_MIGRATION_DATABASE_URL;
  const path = environment.MYSQL_MIGRATION_DATABASE_URL_FILE;
  if (inline && path) {
    throw new MigrationPreflightError('Migration database URL has ambiguous sources');
  }
  if (!path) {
    if (!inline) throw new MigrationPreflightError('Dedicated migration database URL is missing');
    return inline;
  }
  if (!isAbsolute(path)) {
    throw new MigrationPreflightError('Migration database URL file path must be absolute');
  }
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size < 1 || file.size > 4098) {
      throw new MigrationPreflightError('Migration database URL file is invalid');
    }
    const value = readFileSync(path, 'utf8').replace(/\r?\n$/u, '');
    if (value.length < 1 || value.length > 4096 || /[\r\n]/u.test(value)) {
      throw new MigrationPreflightError('Migration database URL file is invalid');
    }
    return value;
  } catch (error) {
    if (error instanceof MigrationPreflightError) throw error;
    throw new MigrationPreflightError('Migration database URL file is unavailable');
  }
}

const migrationReferencePattern = /^[A-Za-z0-9._:-]{8,128}$/u;

export function productionMigrationApproval(environment = process.env, now = new Date()) {
  if (!migrationReferencePattern.test(environment.H5CS_MIGRATION_CHANGE_ID ?? '')) {
    throw new MigrationPreflightError('Production migration requires a change reference');
  }
  const backupRef = environment.H5CS_MIGRATION_BACKUP_REF ?? '';
  const pilotRiskRef = environment.H5CS_MIGRATION_RISK_ACCEPTANCE_REF ?? '';
  if (Boolean(backupRef) === Boolean(pilotRiskRef)) {
    throw new MigrationPreflightError(
      'Production migration requires exactly one backup or controlled-pilot risk reference',
    );
  }
  if (backupRef) {
    if (!migrationReferencePattern.test(backupRef)) {
      throw new MigrationPreflightError('Production migration backup reference is invalid');
    }
    return { mode: 'backed-up' };
  }
  const expiresAt = Date.parse(environment.H5CS_PILOT_EXPIRES_AT ?? '');
  if (
    environment.H5CS_CONTROLLED_PILOT !== 'true' ||
    !migrationReferencePattern.test(pilotRiskRef) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now.valueOf() ||
    expiresAt > Date.parse('2026-11-03T15:59:59Z')
  ) {
    throw new MigrationPreflightError('Controlled-pilot migration risk acceptance is invalid');
  }
  return { mode: 'controlled-pilot' };
}

const row = (value) => (Array.isArray(value) && value.length === 1 ? value[0] : null);

async function verifyLiveConnection(connection, expectedDatabase) {
  const [databaseRows] = await connection.query('SELECT DATABASE() AS selected_database');
  if (row(databaseRows)?.selected_database !== expectedDatabase) {
    throw new MigrationPreflightError(
      'Connected MySQL database does not match the expected database',
    );
  }
  const [tlsRows] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  if (typeof row(tlsRows)?.Value !== 'string' || row(tlsRows).Value.length === 0) {
    throw new MigrationPreflightError('MySQL connection did not negotiate TLS');
  }
}

async function applyMigrations(options, inventory) {
  if (inventory.planSha256 !== options.acceptedPlanSha256) {
    throw new MigrationPreflightError('Migration plan hash changed; run --inventory again');
  }
  if (process.env.APP_ENV !== options.target) {
    throw new MigrationPreflightError('APP_ENV does not match the confirmed migration target');
  }
  if (options.target === 'production') productionMigrationApproval();
  const migrationUrl = migrationDatabaseUrl();
  const { loadDatabaseConfig } = await import('../dist/config.js');
  const loaded = loadDatabaseConfig({
    ...process.env,
    MYSQL_DATABASE_URL: migrationUrl,
    NODE_ENV: 'production',
  });
  if (!loaded.configured || !loaded.config.summary.tlsRequested) {
    throw new MigrationPreflightError('Verified MySQL TLS configuration is required');
  }
  if (
    loaded.config.summary.host !== options.expectedHost ||
    loaded.config.summary.database !== options.expectedDatabase
  ) {
    throw new MigrationPreflightError('MySQL host or database differs from the confirmed target');
  }
  const connection = await loaded.config.openConnection();
  let locked = false;
  try {
    await verifyLiveConnection(connection, options.expectedDatabase);
    const [lockRows] = await connection.query(
      "SELECT GET_LOCK('h5cs_schema_migration_v1', 0) AS acquired",
    );
    if (row(lockRows)?.acquired !== 1) {
      throw new MigrationPreflightError('Another schema migration is active');
    }
    locked = true;
    const [{ drizzle }, { migrate }] = await Promise.all([
      import('drizzle-orm/mysql2'),
      import('drizzle-orm/mysql2/migrator'),
    ]);
    await migrate(drizzle({ client: connection }), { migrationsFolder });
  } finally {
    if (locked) {
      await connection
        .query("SELECT RELEASE_LOCK('h5cs_schema_migration_v1')")
        .catch(() => undefined);
    }
    await connection.end().catch(() => undefined);
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseMigrationArguments(args);
  const inventory = migrationInventory();
  if (options.action === 'inventory') {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
    return;
  }
  await applyMigrations(options, inventory);
  process.stdout.write(
    `MySQL migration completed for ${options.target} ${options.expectedHost}/${options.expectedDatabase}; plan ${inventory.planSha256}\n`,
  );
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    const message =
      error instanceof MigrationPreflightError
        ? error.message
        : 'MySQL migration failed; inspect protected server logs';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
