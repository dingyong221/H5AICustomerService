import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PlatformLoginSessionRecord } from '@h5cs/domain';
import { toMerchantUserId } from '@h5cs/domain';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import { IdentityAuthorizationPersistenceError } from '../src/identity-authorization-repository.js';
import { MySqlPlatformLoginSessionRepository } from '../src/platform-login-session-repository.js';

type SqlCall = Readonly<{ statement: string; values: readonly unknown[] }>;

const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const authenticatedAt = new Date('2026-09-21T11:59:00.000Z');
const now = new Date('2026-09-21T12:00:00.000Z');
const later = new Date('2026-09-21T12:30:00.000Z');
const merchantUserId = toMerchantUserId('11'.repeat(16));

const session: PlatformLoginSessionRecord = {
  sessionDigest: digest(1),
  merchantUserId,
  csrfDigest: digest(2),
  authenticationLevel: 'primary',
  authenticatedAt,
  expiresAt: later,
  revokedAt: null,
  createdAt: now,
  updatedAt: now,
};

const resultHeader = (affectedRows = 1): ResultSetHeader => ({ affectedRows }) as ResultSetHeader;

const repositoryWith = (
  handler: (statement: string, values: readonly unknown[]) => Promise<unknown>,
) => {
  const calls: SqlCall[] = [];
  const beginTransaction = vi.fn(async () => undefined);
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const connection = {
    execute: async (statement: string, values: readonly unknown[] = []) => {
      calls.push({ statement, values });
      return handler(statement, values);
    },
    beginTransaction,
    commit,
    rollback,
    end,
  } as unknown as Connection;
  const config: DatabaseConnectionConfig = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  };
  return {
    repository: new MySqlPlatformLoginSessionRepository(config),
    calls,
    beginTransaction,
    commit,
    rollback,
  };
};

const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  session_digest: Buffer.from(session.sessionDigest),
  merchant_user_id: Buffer.from(merchantUserId, 'hex'),
  csrf_digest: Buffer.from(session.csrfDigest),
  authentication_level: session.authenticationLevel,
  authenticated_at: session.authenticatedAt,
  expires_at: session.expiresAt,
  revoked_at: session.revokedAt,
  created_at: session.createdAt,
  updated_at: session.updatedAt,
  ...overrides,
});

describe('MySQL platform login session repository', () => {
  it('defines an InnoDB digest-only session fact and closes grant foreign keys', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'migrations/0004_fancy_cassandra_nova.sql'),
      'utf8',
    );

    expect(sql).toContain('`session_digest` binary(32) NOT NULL');
    expect(sql).toContain('`csrf_digest` binary(32) NOT NULL');
    expect(sql).not.toMatch(/`(?:session|csrf|cookie)`\s+varchar/iu);
    expect(sql).toContain('ENGINE=InnoDB');
    expect(sql).toContain('fk_connector_authorization_session');
    expect(sql).toContain('fk_workbuddy_bridge_session');
    expect(sql).toContain('fk_connector_consent_identity');
    expect(sql).toContain('MODIFY COLUMN `consent_grant_id` binary(16) NOT NULL');
  });

  it('stores only session and CSRF digests for an active account', async () => {
    const { repository, calls } = repositoryWith(async () => [resultHeader(), []]);

    await repository.storePlatformLoginSession(session);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.statement).toMatch(/INSERT INTO platform_login_session[\s\S]*merchant_user/u);
    expect(calls[0]?.values[0]).toEqual(Buffer.from(session.sessionDigest));
    expect(calls[0]?.values[1]).toEqual(Buffer.from(session.csrfDigest));
    expect(calls[0]?.values).not.toContain('raw-cookie');
    expect(calls[0]?.values).not.toContain('raw-csrf');
  });

  it('resolves active sessions and requires the CSRF digest on mutation reads', async () => {
    const { repository, calls } = repositoryWith(async () => [[sessionRow()], []]);

    await expect(
      repository.resolvePlatformLoginSession(session.sessionDigest, now),
    ).resolves.toEqual(session);
    await expect(
      repository.resolvePlatformMutationSession(session.sessionDigest, session.csrfDigest, now),
    ).resolves.toEqual(session);

    expect(calls[0]?.statement).toMatch(/merchant_user[\s\S]*u\.status = 'active'/u);
    expect(calls[0]?.statement).not.toMatch(/s\.csrf_digest = \?/u);
    expect(calls[1]?.statement).toMatch(/s\.csrf_digest = \?/u);
    expect(calls[1]?.values[1]).toEqual(Buffer.from(session.csrfDigest));
  });

  it('revokes a session once under a row lock', async () => {
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT s.session_digest')) return [[sessionRow()], []];
      return [resultHeader(), []];
    });

    await expect(repository.revokePlatformLoginSession(session.sessionDigest, now)).resolves.toBe(
      true,
    );
    expect(calls[0]?.statement).toMatch(/FOR UPDATE/u);
    expect(calls[1]?.statement).toMatch(/revoked_at = \?/u);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('rejects invalid digests before opening a connection', async () => {
    const openConnection = vi.fn(async () => {
      throw new Error('must not connect');
    });
    const repository = new MySqlPlatformLoginSessionRepository({
      openConnection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    });

    await expect(
      repository.resolvePlatformLoginSession(new Uint8Array(31), now),
    ).rejects.toBeInstanceOf(IdentityAuthorizationPersistenceError);
    expect(openConnection).not.toHaveBeenCalled();
  });
});
