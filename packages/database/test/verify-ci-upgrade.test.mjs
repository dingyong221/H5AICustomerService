import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { migrationInventory } from '../scripts/migrate-managed.mjs';
import {
  UpgradeProbeError,
  acquireMigrationLock,
  assertEmptyCiDatabase,
  assertMigrationHistory,
  assertTemporaryTarget,
  assertUpgradedTableSet,
  baselineMigrationFolder,
  normalizeStoredValue,
  parseUpgradeArguments,
  readMysqlVersion,
  reviewedUpgradePlan,
  runUpgradeProbe,
  safeProbeFailure,
  storedRowsDigest,
  validateUpgradeTarget,
} from '../scripts/verify-ci-upgrade.mjs';

const valid = {
  CI: 'true',
  H5CS_INTEGRATION_MYSQL_URL:
    'mysql://h5cs_ci:do-not-print-test-secret@127.0.0.1:3306/h5cs_integration_ci',
};
const sourceFolder = fileURLToPath(new URL('../migrations/', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/verify-ci-upgrade.mjs', import.meta.url));

describe('offline CI upgrade probe scope and argument safety', () => {
  it('accepts only the exact baseline plus improvement and governance tables', () => {
    const baseline = Array.from({ length: 29 }, (_, index) => `baseline_${index}`);
    const upgraded = [
      ...baseline,
      'assistant_improvement',
      'assistant_evaluation_run',
      'assistant_publication_governance',
      'merchant_assistant',
      'marketplace_allocation',
      'marketplace_campaign',
      'marketplace_claim_code',
      'marketplace_entitlement',
      'marketplace_free_claim',
      'marketplace_model_attempt',
      'marketplace_signup_throttle',
    ];
    expect(() => assertUpgradedTableSet(upgraded, baseline)).not.toThrow();
    for (const invalid of [
      upgraded.slice(0, -1),
      [...upgraded, 'unexpected_table'],
      [...upgraded.slice(0, -1), 'unexpected_table'],
      [...upgraded.slice(0, -1), 'assistant_improvement'],
    ])
      expect(() => assertUpgradedTableSet(invalid, baseline)).toThrow(UpgradeProbeError);
    expect(() => assertUpgradedTableSet(upgraded, baseline.slice(1))).toThrow(UpgradeProbeError);
  });

  it('requires one explicit action and rejects database, SQL or destructive override options', () => {
    expect(parseUpgradeArguments(['--run'])).toEqual({ action: 'run' });
    expect(parseUpgradeArguments(['--check-target'])).toEqual({ action: 'check-target' });
    for (const args of [
      [],
      ['--run', '--run'],
      ['--reset'],
      ['--run', '--force'],
      ['--run', '--database=h5cs_prod'],
      ['--migrations=elsewhere'],
      ['--run', '--check-target'],
    ])
      expect(() => parseUpgradeArguments(args)).toThrow(UpgradeProbeError);
  });

  it('accepts only the explicit CI loopback database/account without returning credentials', () => {
    expect(validateUpgradeTarget(valid)).toEqual({
      host: '127.0.0.1',
      port: 3306,
      database: 'h5cs_integration_ci',
      user: 'h5cs_ci',
    });
    expect(
      validateUpgradeTarget({
        ...valid,
        H5CS_INTEGRATION_MYSQL_URL: valid.H5CS_INTEGRATION_MYSQL_URL.replace(
          '127.0.0.1:3306',
          'localhost:13306',
        ),
      }).port,
    ).toBe(13306);
    expect(JSON.stringify(validateUpgradeTarget(valid))).not.toContain('test-secret');
  });

  it('fails before a database driver is imported for non-CI or production environments', async () => {
    for (const patch of [
      { CI: undefined },
      { CI: 'false' },
      { CI: 'TRUE' },
      { NODE_ENV: 'production' },
      { APP_ENV: 'production' },
      { H5CS_MYSQL_DATABASE: 'h5cs_prod' },
    ]) {
      expect(() => validateUpgradeTarget({ ...valid, ...patch })).toThrow(UpgradeProbeError);
      await expect(runUpgradeProbe({ ...valid, ...patch })).rejects.toBeInstanceOf(
        UpgradeProbeError,
      );
    }
  });

  it('rejects external/production databases, root accounts, socket/query redirects and ambiguous URLs', () => {
    const invalid = [
      'mysql://h5cs_ci:test@114.132.92.111/h5cs_integration_ci',
      'mysql://h5cs_ci:test@mysql.internal/h5cs_integration_ci',
      'mysql://h5cs_ci:test@127.0.0.1/h5cs_prod',
      'mysql://root:test@127.0.0.1/h5cs_integration_ci',
      'mysql://h5cs_ci@127.0.0.1/h5cs_integration_ci',
      'mysql://h5cs_ci:test@127.0.0.1/h5cs_integration_ci?socketPath=/tmp/mysql.sock',
      'mysql://h5cs_ci:test@127.0.0.1/h5cs_integration_ci?database=h5cs_prod',
      'mysql://h5cs_ci:test@127.0.0.1/h5cs_integration_ci#production',
      'mysql://h5cs_ci:test@127.0.0.1:0/h5cs_integration_ci',
      'mysql://h5cs_ci:test@127.0.0.1:65536/h5cs_integration_ci',
      'mysql://h5cs_ci:test@localhost.example/h5cs_integration_ci',
      'mysql://h5cs_ci:test@[::1]/h5cs_integration_ci',
      'mysql://h5cs_ci:test@127.0.0.1/%68%35cs_integration_ci',
      ` ${valid.H5CS_INTEGRATION_MYSQL_URL}`,
      `${valid.H5CS_INTEGRATION_MYSQL_URL}\n`,
      'not a URL with do-not-print-test-secret',
    ];
    for (const url of invalid) {
      expect(() => validateUpgradeTarget({ ...valid, H5CS_INTEGRATION_MYSQL_URL: url })).toThrow(
        UpgradeProbeError,
      );
      try {
        validateUpgradeTarget({ ...valid, H5CS_INTEGRATION_MYSQL_URL: url });
      } catch (error) {
        expect(error.message).not.toContain(url);
      }
    }
  });

  it('requires the actual selected database and effective account to match before checking emptiness', async () => {
    for (const identity of [
      { selected_database: 'h5cs_prod', connected_account: 'h5cs_ci@%' },
      { selected_database: 'h5cs_integration_ci', connected_account: 'root@localhost' },
    ]) {
      const query = vi.fn(async () => [[identity], []]);
      await expect(assertEmptyCiDatabase({ query })).rejects.toThrow('Live connection');
      expect(query).toHaveBeenCalledOnce();
    }
  });

  it('does not initialize a nonempty database, including an empty migration tracker or any routine/event', async () => {
    for (const object of [
      { kind: 'table_or_view', object_name: '__drizzle_migrations' },
      { kind: 'table_or_view', object_name: 'merchant' },
      { kind: 'routine', object_name: 'unknown_routine' },
      { kind: 'event', object_name: 'unknown_event' },
      { kind: 'trigger', object_name: 'unknown_trigger' },
    ]) {
      const query = vi
        .fn()
        .mockResolvedValueOnce([
          [{ selected_database: 'h5cs_integration_ci', connected_account: 'h5cs_ci@%' }],
          [],
        ])
        .mockResolvedValueOnce([[object], []]);
      await expect(assertEmptyCiDatabase({ query })).rejects.toThrow('not empty');
      expect(query).toHaveBeenCalledTimes(2);
      for (const [sql] of query.mock.calls)
        expect(sql).not.toMatch(/CREATE|INSERT|DROP|DELETE|TRUNCATE|UPDATE/iu);
    }
  });

  it('accepts a genuinely empty scoped CI database without doing writes during preflight', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        [{ selected_database: 'h5cs_integration_ci', connected_account: 'h5cs_ci@%' }],
        [],
      ])
      .mockResolvedValueOnce([[], []]);
    await expect(assertEmptyCiDatabase({ query })).resolves.toBeUndefined();
    expect(query.mock.calls[1]?.[0]).toContain('TABLE_SCHEMA = DATABASE()');
    expect(query.mock.calls[1]?.[0]).toContain('ROUTINE_SCHEMA = DATABASE()');
  });

  it('supports an offline CLI target check without connecting or exposing the URL/password', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--check-target'], {
      env: { ...process.env, ...valid, APP_ENV: 'test', NODE_ENV: 'test' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      noDatabaseConnected: true,
      migrationCount: 17,
      target: { database: 'h5cs_integration_ci' },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain('test-secret');
    expect(`${result.stdout}${result.stderr}`).not.toContain('mysql://');
  });
});

describe('offline upgrade migration and data-proof helpers', () => {
  it('accepts advisory-lock success as numeric or mysql2 BIGINT string, without accepting falsy/coerced results', async () => {
    for (const value of [1, '1']) {
      const query = vi.fn(async () => [[{ acquired: value }], []]);
      await expect(acquireMigrationLock({ query })).resolves.toEqual({
        acquired: true,
        driverValueType: typeof value,
      });
      expect(query).toHaveBeenCalledWith(
        "SELECT GET_LOCK('h5cs_schema_migration_v1', 0) AS acquired",
      );
    }
    for (const value of [0, '0', null, undefined, true, '01', '1.0', 1n]) {
      const query = vi.fn(async () => [[{ acquired: value }], []]);
      await expect(acquireMigrationLock({ query })).rejects.toBeInstanceOf(UpgradeProbeError);
    }
  });

  it('reports only the safe execution phase and nested driver code/errno, never SQL/credentials/stack', () => {
    const secret = 'do-not-print-test-secret';
    const driver = Object.assign(new Error(`mysql://account:${secret}@server/db`), {
      code: 'ER_BAD_FIELD_ERROR',
      errno: 1054,
      sql: `INSERT INTO secret_table VALUES ('${secret}')`,
    });
    const outer = new Error(`Failed query: ${driver.sql}`, { cause: driver });
    const diagnostic = safeProbeFailure(outer, 'seed_baseline_data');
    expect(diagnostic).toBeInstanceOf(UpgradeProbeError);
    expect(diagnostic.message).toContain('phase=seed_baseline_data');
    expect(diagnostic.message).toContain('driver_code=ER_BAD_FIELD_ERROR driver_errno=1054');
    for (const omitted of [secret, 'mysql://', 'secret_table', 'INSERT INTO', 'Failed query'])
      expect(diagnostic.message).not.toContain(omitted);
    expect(safeProbeFailure(diagnostic, 'cli_preflight').message).toBe(diagnostic.message);
    expect(
      safeProbeFailure(new UpgradeProbeError(secret), 'verify_empty_database').message,
    ).not.toContain(secret);
    expect(
      safeProbeFailure(
        Object.assign(new Error(secret), { code: 'ECONNREFUSED', errno: -4078 }),
        'connect_database',
      ).message,
    ).toContain('driver_code=ECONNREFUSED driver_errno=-4078');
    const malformed = safeProbeFailure(
      Object.assign(new Error(secret), { code: secret, errno: secret }),
      `mysql://${secret}`,
    );
    expect(malformed.message).toContain('phase=unknown');
    expect(malformed.message).toContain('driver_code=unavailable driver_errno=unavailable');
    expect(malformed.message).not.toContain(secret);
  });

  it('records the actual MySQL version returned by the server instead of a configured image tag', async () => {
    const query = vi.fn(async () => [[{ mysql_version: '8.4.11' }], []]);
    await expect(readMysqlVersion({ query })).resolves.toBe('8.4.11');
    expect(query).toHaveBeenCalledWith('SELECT VERSION() AS mysql_version');
    await expect(
      readMysqlVersion({ query: vi.fn(async () => [[{ mysql_version: '' }], []]) }),
    ).rejects.toThrow('expected version identifier');
  });

  it('uses the exact sixteen real SQL migrations and copies only the baseline twelve without changing source SQL', async () => {
    const plan = await reviewedUpgradePlan();
    const sourceBefore = migrationInventory();
    expect(plan.entries).toHaveLength(17);
    expect(plan.entries[12].tag).toMatch(/^0012_/u);
    const scratch = await baselineMigrationFolder(plan);
    try {
      const baseline = migrationInventory(
        scratch.folder,
        join(scratch.folder, 'meta', '_journal.json'),
      );
      expect(baseline.entries).toEqual(sourceBefore.entries.slice(0, 12));
      expect(existsSync(join(scratch.folder, `${plan.entries[12].tag}.sql`))).toBe(false);
      for (const entry of baseline.entries)
        expect(await readFile(join(scratch.folder, `${entry.tag}.sql`))).toEqual(
          await readFile(join(sourceFolder, `${entry.tag}.sql`)),
        );
    } finally {
      await scratch.cleanup();
    }
    expect(existsSync(scratch.folder)).toBe(false);
    expect(migrationInventory()).toEqual(sourceBefore);
  });

  it('never authorizes cleanup of a parent, workspace or arbitrary sibling directory', () => {
    const parent = resolve(tmpdir());
    const accepted = join(parent, 'h5cs-ci-upgrade-Ab12Cd');
    expect(assertTemporaryTarget(parent, accepted)).toBe(accepted);
    for (const target of [
      parent,
      resolve('/'),
      join(parent, '..'),
      join(parent, 'h5cs-ci-upgrade-'),
      join(parent, 'another-project-Ab12Cd'),
      join(parent, 'nested', 'h5cs-ci-upgrade-Ab12Cd'),
    ])
      expect(() => assertTemporaryTarget(parent, target)).toThrow(UpgradeProbeError);
  });

  it('checks every real migration hash, timestamp and ordered ID rather than only history count', async () => {
    const plan = await reviewedUpgradePlan();
    const correct = plan.entries.map((entry, index) => ({
      id: String(index + 1),
      hash: entry.sha256,
      created_at: entry.when,
    }));
    const connection = (rows) => ({ query: vi.fn(async () => [rows, []]) });
    expect(await assertMigrationHistory(connection(correct), plan.entries)).toHaveLength(17);
    for (const [index, patch] of [
      [0, { hash: '0'.repeat(64) }],
      [5, { created_at: '1' }],
      [11, { id: '99' }],
    ]) {
      const changed = correct.map((row, offset) => (offset === index ? { ...row, ...patch } : row));
      await expect(assertMigrationHistory(connection(changed), plan.entries)).rejects.toThrow(
        'hash, timestamp or order',
      );
    }
    await expect(
      assertMigrationHistory(connection(correct.slice(1)), plan.entries),
    ).rejects.toThrow('count');
    await expect(
      assertMigrationHistory(connection([...correct, correct[12]]), plan.entries),
    ).rejects.toThrow('count');
  });

  it('hashes all columns and binary/JSON content deterministically without relying on row or JSON-key order', () => {
    const first = [
      { id: Buffer.from('01', 'hex'), config: { price: 99, faq: ['中文', '☕'] }, nullable: null },
      { id: Buffer.from('02', 'hex'), config: { price: 129 }, nullable: '' },
    ];
    const reordered = [
      { nullable: '', config: { price: 129 }, id: Buffer.from('02', 'hex') },
      { config: { faq: ['中文', '☕'], price: 99 }, nullable: null, id: Buffer.from('01', 'hex') },
    ];
    expect(storedRowsDigest(first)).toBe(storedRowsDigest(reordered));
    expect(storedRowsDigest([{ ...first[0], config: { price: 100 } }, first[1]])).not.toBe(
      storedRowsDigest(first),
    );
    expect(storedRowsDigest([{ ...first[0], nullable: '' }, first[1]])).not.toBe(
      storedRowsDigest(first),
    );
    expect(normalizeStoredValue({ id: Buffer.from('ff', 'hex'), n: 9007199254740993n })).toEqual({
      id: { binary: 'ff' },
      n: { integer: '9007199254740993' },
    });
  });

  it('does not disable foreign keys, reset databases, forge migration rows or invoke model/runtime services', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).not.toMatch(
      /FOREIGN_KEY_CHECKS|DROP\s+(DATABASE|TABLE)|TRUNCATE\s|DELETE\s+FROM/iu,
    );
    expect(source).not.toMatch(/INSERT\s+INTO\s+[`'"]?__drizzle_migrations/iu);
    expect(source).not.toMatch(/https?:\/\/|fetch\(|child_process|ssh\s/iu);
    expect(source).toContain("import('drizzle-orm/mysql2/migrator')");
  });
});
