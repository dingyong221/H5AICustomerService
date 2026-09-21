import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { binaryIdFromString, loadDatabaseConfig } from '../src/index.js';
import { assistants, onboardingSessions } from '../src/schema/index.js';

describe('database connection configuration', () => {
  it('imports the complete Drizzle schema without ESM initialization errors', () => {
    expect(assistants).toBeDefined();
    expect(onboardingSessions).toBeDefined();
  });

  it('rejects malformed values at the BINARY(16) persistence boundary', () => {
    expect(binaryIdFromString('0123456789abcdef0123456789abcdef')).toHaveLength(16);
    expect(() => binaryIdFromString('not-a-binary-id')).toThrow(
      'exactly 32 hexadecimal characters',
    );
    expect(() => binaryIdFromString('')).toThrow('exactly 32 hexadecimal characters');
  });
  it('reports an unconfigured database without guessing a connection', () => {
    expect(loadDatabaseConfig({})).toEqual({
      configured: false,
      reason: 'MYSQL_DATABASE_URL is not set',
    });
  });

  it('only exposes a secret-free summary during serialization', () => {
    const credential = randomBytes(16).toString('hex');
    const databaseUrl = new URL('mysql://mysql.internal/customer_service');
    databaseUrl.username = 'service-user';
    databaseUrl.password = credential;
    databaseUrl.searchParams.set('ssl-mode', 'VERIFY_IDENTITY');
    const result = loadDatabaseConfig({
      MYSQL_DATABASE_URL: databaseUrl.toString(),
    });

    expect(result.configured).toBe(true);
    if (!result.configured) return;

    const serialized = JSON.stringify(result.config);
    expect(serialized).toContain('mysql.internal');
    expect(serialized).toContain('customer_service');
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('service-user');
  });

  it('rejects non-MySQL URLs', () => {
    expect(() =>
      loadDatabaseConfig({ MYSQL_DATABASE_URL: 'postgres://user:secret@db.internal/app' }),
    ).toThrow();
  });

  it('ships an InnoDB utf8mb4 migration with tenant ownership constraints', () => {
    const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const migrationName = readdirSync(migrationsDirectory).find((name) => name.endsWith('.sql'));
    expect(migrationName).toBeDefined();

    const migration = readFileSync(`${migrationsDirectory}/${String(migrationName)}`, 'utf8');
    expect(migration).toContain('ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4');
    expect(migration).toContain('fk_session_release');
    expect(migration).toContain('fk_assistant_active_release');
    expect(migration).toContain('uq_idempotency_scope_key');
    expect(migration).toContain('idx_job_claim');
  });

  it('migrates scoped WorkBuddy identity and assistant-owned onboarding results', () => {
    const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const migrations = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(`${migrationsDirectory}/${name}`, 'utf8'))
      .join('\n');

    expect(migrations).toContain('`phone_match_verified_at` datetime(6),');
    expect(migrations).toContain('UNIQUE(`provider`,`issuer`,`audience`,`subject_lookup_key`)');
    expect(migrations).toContain('fk_onboarding_session_assistant');
    expect(migrations).toContain('`subject_lookup_key_version` int unsigned NOT NULL');
    expect(migrations).not.toContain('`open_id`');
  });
});
