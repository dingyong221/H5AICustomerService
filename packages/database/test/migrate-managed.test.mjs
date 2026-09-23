import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MigrationPreflightError,
  migrationInventory,
  parseMigrationArguments,
} from '../scripts/migrate-managed.mjs';

describe('managed MySQL migration preflight', () => {
  it('lists every repository migration with a stable plan hash', () => {
    const first = migrationInventory();
    const second = migrationInventory();
    expect(first).toEqual(second);
    expect(first.dialect).toBe('mysql');
    expect(first.entries.length).toBeGreaterThan(0);
    expect(new Set(first.entries.map((entry) => entry.tag)).size).toBe(first.entries.length);
    expect(first.planSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

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
