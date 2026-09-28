import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MigrationPreflightError,
  migrationDatabaseUrl,
  migrationInventory,
  parseMigrationArguments,
} from '../scripts/migrate-managed.mjs';

describe('managed MySQL migration preflight', () => {
  it('reads a bounded migration URL from one protected file source without exposing it in errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'h5cs-migration-secret-'));
    const path = join(directory, 'migration-url');
    const secret = 'mysql://migrator:test-secret@mysql.internal/h5cs_prod?ssl-mode=VERIFY_IDENTITY';
    writeFileSync(path, `${secret}\n`);
    try {
      expect(() => migrationDatabaseUrl({})).toThrow('Dedicated migration database URL is missing');
      expect(migrationDatabaseUrl({ MYSQL_MIGRATION_DATABASE_URL_FILE: path })).toBe(secret);
      expect(() =>
        migrationDatabaseUrl({
          MYSQL_MIGRATION_DATABASE_URL_FILE: path,
          MYSQL_MIGRATION_DATABASE_URL: secret,
        }),
      ).toThrow('ambiguous sources');
      expect(() =>
        migrationDatabaseUrl({ MYSQL_MIGRATION_DATABASE_URL_FILE: 'relative/migration-url' }),
      ).toThrow('path must be absolute');
      writeFileSync(path, `${secret}\nanother-line`);
      expect(() => migrationDatabaseUrl({ MYSQL_MIGRATION_DATABASE_URL_FILE: path })).toThrow(
        'file is invalid',
      );
      unlinkSync(path);
      expect(() => migrationDatabaseUrl({ MYSQL_MIGRATION_DATABASE_URL_FILE: path })).toThrow(
        'file is unavailable',
      );
    } finally {
      if (existsSync(path)) unlinkSync(path);
      rmdirSync(directory);
    }
  });
  it('lists every repository migration with a stable plan hash', () => {
    const first = migrationInventory();
    const second = migrationInventory();
    expect(first).toEqual(second);
    expect(first.dialect).toBe('mysql');
    expect(first.entries.length).toBeGreaterThan(0);
    expect(new Set(first.entries.map((entry) => entry.tag)).size).toBe(first.entries.length);
    expect(first.planSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.skipIf(process.platform === 'win32')(
    'runs the inventory through the symlinked package path used by the API image',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'h5cs-migration-entry-'));
      const entry = join(directory, 'migrate-managed.mjs');
      const script = realpathSync(
        fileURLToPath(new URL('../scripts/migrate-managed.mjs', import.meta.url)),
      );
      try {
        symlinkSync(script, entry);
        const result = spawnSync(process.execPath, [entry, '--inventory'], {
          cwd: directory,
          encoding: 'utf8',
        });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout).planSha256).toBe(migrationInventory().planSha256);
      } finally {
        if (existsSync(entry)) unlinkSync(entry);
        rmdirSync(directory);
      }
    },
  );

  it('rejects a journal and SQL directory that do not match exactly', () => {
    const directory = mkdtempSync(join(tmpdir(), 'h5cs-migration-inventory-'));
    const journalPath = join(directory, 'journal.json');
    const sqlPath = join(directory, '0000_test.sql');
    const extraPath = join(directory, '0001_untracked.sql');
    writeFileSync(
      journalPath,
      JSON.stringify({ dialect: 'mysql', entries: [{ idx: 0, tag: '0000_test' }] }),
    );
    writeFileSync(sqlPath, 'SELECT 1;\n');
    try {
      const baseline = migrationInventory(directory, journalPath);
      writeFileSync(extraPath, 'SELECT 2;\n');
      expect(() => migrationInventory(directory, journalPath)).toThrow(MigrationPreflightError);
      unlinkSync(extraPath);
      writeFileSync(sqlPath, 'SELECT 3;\n');
      expect(migrationInventory(directory, journalPath).planSha256).not.toBe(baseline.planSha256);
    } finally {
      unlinkSync(sqlPath);
      unlinkSync(journalPath);
      rmdirSync(directory);
    }
  });

  it('requires exact apply target, host, database and accepted plan hash', () => {
    const hash = 'a'.repeat(64);
    expect(parseMigrationArguments(['--inventory'])).toEqual({ action: 'inventory' });
    expect(
      parseMigrationArguments([
        '--apply',
        '--target=staging',
        '--expect-host=mysql.internal',
        '--expect-database=h5cs_staging',
        `--accept-plan-sha256=${hash}`,
      ]),
    ).toEqual({
      action: 'apply',
      target: 'staging',
      expectedHost: 'mysql.internal',
      expectedDatabase: 'h5cs_staging',
      acceptedPlanSha256: hash,
    });
    for (const args of [
      [],
      ['--apply'],
      ['--inventory', '--apply'],
      [
        '--apply',
        '--target=local',
        '--expect-host=mysql.internal',
        '--expect-database=h5cs',
        `--accept-plan-sha256=${hash}`,
      ],
      [
        '--apply',
        '--target=production',
        '--expect-host=10.8.1.5',
        '--expect-database=h5cs',
        `--accept-plan-sha256=${hash}`,
      ],
      [
        '--apply',
        '--target=production',
        '--expect-host=mysql.internal',
        '--expect-database=h5cs',
        '--accept-plan-sha256=wrong',
      ],
    ]) {
      expect(() => parseMigrationArguments(args)).toThrow(MigrationPreflightError);
    }
  });
});
