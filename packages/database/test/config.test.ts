import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'mysql2/promise';

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
    const databaseUrl = new URL('mysql://127.0.0.1/customer_service');
    databaseUrl.username = 'service-user';
    databaseUrl.password = credential;
    const result = loadDatabaseConfig({
      MYSQL_DATABASE_URL: databaseUrl.toString(),
    });

    expect(result.configured).toBe(true);
    if (!result.configured) return;

    const serialized = JSON.stringify(result.config);
    expect(serialized).toContain('127.0.0.1');
    expect(serialized).toContain('customer_service');
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain('service-user');
  });

  it('rejects remote MySQL without explicit verified TLS configuration', () => {
    const remote = 'mysql://service:secret@mysql.internal/customer_service';
    expect(loadDatabaseConfig({ MYSQL_DATABASE_URL: remote })).toEqual({
      configured: false,
      reason: 'Managed MySQL requires ssl-mode=VERIFY_IDENTITY',
    });
    expect(
      loadDatabaseConfig({ MYSQL_DATABASE_URL: `${remote}?ssl-mode=VERIFY_IDENTITY` }),
    ).toEqual({
      configured: false,
      reason: 'MYSQL_TLS_CA_FILE is missing or invalid',
    });
    expect(
      loadDatabaseConfig({
        APP_ENV: 'production',
        MYSQL_DATABASE_URL: 'mysql://service:secret@127.0.0.1/customer_service',
      }),
    ).toEqual({
      configured: false,
      reason: 'Production MySQL cannot use a loopback host',
    });
    expect(
      loadDatabaseConfig({
        MYSQL_DATABASE_URL:
          'mysql://service:secret@10.8.0.5/customer_service?ssl-mode=VERIFY_IDENTITY',
      }),
    ).toEqual({
      configured: false,
      reason: 'Managed MySQL requires a DNS hostname',
    });
    expect(
      loadDatabaseConfig({
        MYSQL_DATABASE_URL:
          'mysql://service:secret@[::1]/customer_service?ssl-mode=VERIFY_IDENTITY',
      }),
    ).toEqual({
      configured: false,
      reason: 'Managed MySQL requires a DNS hostname',
    });
    expect(() => loadDatabaseConfig({ MYSQL_DATABASE_URL: `${remote}?ssl=false` })).toThrow(
      'Unsupported MySQL URL option',
    );
  });

  it('passes a CA and identity verification to mysql2 without exposing credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'h5cs-mysql-ca-'));
    const caFile = join(directory, 'ca.pem');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nTEST-ONLY\n-----END CERTIFICATE-----\n');
    try {
      const connect = vi.fn(async () => ({}) as Connection);
      const result = loadDatabaseConfig(
        {
          APP_ENV: 'production',
          MYSQL_DATABASE_URL:
            'mysql://service:secret@mysql.internal/customer_service?ssl-mode=VERIFY_IDENTITY',
          MYSQL_TLS_CA_FILE: caFile,
        },
        connect,
      );
      expect(result.configured).toBe(true);
      if (!result.configured) return;
      expect(result.config.summary.tlsRequested).toBe(true);
      await result.config.openConnection();
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'mysql.internal',
          ssl: expect.objectContaining({ rejectUnauthorized: true, verifyIdentity: true }),
        }),
      );
      expect(JSON.stringify(result.config)).not.toContain('secret');
      expect(JSON.stringify(result.config)).not.toContain('TEST-ONLY');
    } finally {
      unlinkSync(caFile);
      rmdirSync(directory);
    }
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
