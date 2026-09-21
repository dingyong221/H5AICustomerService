import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  OAuthAuthorizationCodeRecord,
  OAuthRefreshTokenContext,
  OAuthRefreshTokenRecord,
} from '@h5cs/domain';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import { MySqlOAuthRepository, OAuthPersistenceError } from '../src/oauth-repository.js';

type SqlCall = Readonly<{ statement: string; values: readonly unknown[] }>;

const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const now = new Date('2026-09-21T12:00:00.000Z');
const later = new Date('2026-09-21T12:10:00.000Z');

const codeRecord: OAuthAuthorizationCodeRecord = {
  codeDigest: digest(1),
  clientId: 'public-client-id',
  redirectUri: 'http://127.0.0.1:43123/callback',
  resource: 'https://h5cs.example.test/mcp',
  scope: 'mcp:tools',
  codeChallenge: 'A'.repeat(43),
  bindingId: 'binding_server_controlled',
  expiresAt: later,
  createdAt: now,
};

const refreshRecord: OAuthRefreshTokenRecord = {
  tokenDigest: digest(2),
  familyId: 'refresh-family-id',
  clientId: 'public-client-id',
  bindingId: 'binding_server_controlled',
  resource: 'https://h5cs.example.test/mcp',
  scope: 'mcp:tools',
  expiresAt: later,
  createdAt: now,
};

const expectedContext: OAuthRefreshTokenContext = {
  clientId: refreshRecord.clientId,
  resource: refreshRecord.resource,
  scope: refreshRecord.scope,
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
    repository: new MySqlOAuthRepository(config),
    calls,
    beginTransaction,
    commit,
    rollback,
    end,
  };
};

const activeRefreshRow = (overrides: Record<string, unknown> = {}) => ({
  family_id_digest: Buffer.from(digest(9)),
  family_id: refreshRecord.familyId,
  client_id: refreshRecord.clientId,
  binding_id: refreshRecord.bindingId,
  resource: refreshRecord.resource,
  scope: refreshRecord.scope,
  family_revoked_at: null,
  expires_at: refreshRecord.expiresAt,
  used_at: null,
  created_at: refreshRecord.createdAt,
  ...overrides,
});

describe('MySQL OAuth repository', () => {
  it('migration stores only binary code/token digests with InnoDB FKs and indexes', async () => {
    const sql = await readFile(resolve(process.cwd(), 'migrations/0002_demonic_ulik.sql'), 'utf8');

    expect(sql).toContain('`code_digest` binary(32) NOT NULL');
    expect(sql).toContain('`token_digest` binary(32) NOT NULL');
    expect(sql).toContain('`family_id_digest` binary(32) NOT NULL');
    expect(sql).not.toMatch(/`authorization_code`\s+varchar/iu);
    expect(sql).not.toMatch(/`refresh_token`\s+varchar/iu);
    expect(sql.match(/ENGINE=InnoDB/gu)).toHaveLength(4);
    expect(sql).toContain('fk_oauth_authorization_code_client');
    expect(sql).toContain('fk_oauth_refresh_token_family');
    expect(sql).toContain('idx_oauth_refresh_token_expiry');
  });

  it('registers public clients by a case-sensitive digest and round-trips strict metadata', async () => {
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT client_id')) {
        return [
          [
            {
              client_id: 'public-client-id',
              client_name: 'Local MCP',
              redirect_uris: JSON.stringify(['http://127.0.0.1:43123/callback']),
              created_at: now,
            },
          ],
          [],
        ];
      }
      return [resultHeader(), []];
    });

    await repository.registerPublicClient({
      clientId: 'public-client-id',
      clientName: 'Local MCP',
      redirectUris: ['http://127.0.0.1:43123/callback'],
      createdAt: now,
    });
    await expect(repository.findPublicClient('public-client-id')).resolves.toEqual({
      clientId: 'public-client-id',
      clientName: 'Local MCP',
      redirectUris: ['http://127.0.0.1:43123/callback'],
      createdAt: now,
    });

    const insert = calls[0];
    const lookup = calls[1];
    expect(insert?.values[0]).toBeInstanceOf(Buffer);
    expect(insert?.values[0]).toHaveLength(32);
    expect(lookup?.values[0]).toEqual(insert?.values[0]);
  });

  it('consumes an authorization-code digest once under a row lock', async () => {
    const { repository, calls, beginTransaction, commit, rollback } = repositoryWith(
      async (statement) => {
        if (statement.includes('SELECT c.client_id')) {
          return [
            [
              {
                client_id: codeRecord.clientId,
                redirect_uri: codeRecord.redirectUri,
                resource: codeRecord.resource,
                scope: codeRecord.scope,
                code_challenge: codeRecord.codeChallenge,
                binding_id: codeRecord.bindingId,
                expires_at: codeRecord.expiresAt,
                consumed_at: null,
                created_at: codeRecord.createdAt,
              },
            ],
            [],
          ];
        }
        return [resultHeader(), []];
      },
    );

    await expect(repository.consumeAuthorizationCode(codeRecord.codeDigest, now)).resolves.toEqual(
      codeRecord,
    );
    expect(beginTransaction).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(calls[0]?.statement).toMatch(/FOR UPDATE/u);
    expect(calls[1]?.statement).toMatch(/SET consumed_at/u);
    expect(calls[0]?.values[0]).toEqual(Buffer.from(codeRecord.codeDigest));
  });

  it('does not update an already consumed authorization code', async () => {
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT c.client_id')) {
        return [
          [
            {
              client_id: codeRecord.clientId,
              redirect_uri: codeRecord.redirectUri,
              resource: codeRecord.resource,
              scope: codeRecord.scope,
              code_challenge: codeRecord.codeChallenge,
              binding_id: codeRecord.bindingId,
              expires_at: codeRecord.expiresAt,
              consumed_at: now,
              created_at: codeRecord.createdAt,
            },
          ],
          [],
        ];
      }
      throw new Error('must not update a consumed code');
    });

    await expect(
      repository.consumeAuthorizationCode(codeRecord.codeDigest, now),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('stores refresh family and token digests atomically without plaintext tokens', async () => {
    const { repository, calls, commit } = repositoryWith(async () => [resultHeader(), []]);

    await repository.storeRefreshToken(refreshRecord);

    expect(commit).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.statement).toContain('oauth_refresh_token_family');
    expect(calls[1]?.statement).toContain('oauth_refresh_token');
    expect(calls[1]?.values[0]).toEqual(Buffer.from(refreshRecord.tokenDigest));
    expect(calls.flatMap((call) => call.values)).not.toContain('raw-refresh-token');
  });

  it('rotates an active refresh token inside one transaction', async () => {
    const replacement = {
      tokenDigest: digest(3),
      expiresAt: new Date('2026-10-21T12:00:00.000Z'),
      createdAt: now,
    };
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT t.family_id_digest')) {
        return [[activeRefreshRow()], []];
      }
      return [resultHeader(), []];
    });

    await expect(
      repository.rotateRefreshToken(refreshRecord.tokenDigest, replacement, expectedContext, now),
    ).resolves.toEqual({ status: 'rotated', previous: refreshRecord });
    expect(commit).toHaveBeenCalledOnce();
    expect(calls[0]?.statement).toMatch(/FOR UPDATE/u);
    expect(calls[1]?.statement).toMatch(/INSERT INTO oauth_refresh_token/u);
    expect(calls[2]?.statement).toMatch(/replacement_token_digest/u);
    expect(calls[1]?.values[0]).toEqual(Buffer.from(replacement.tokenDigest));
  });

  it('revokes the whole family on replay without creating another token', async () => {
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT t.family_id_digest')) {
        return [[activeRefreshRow({ used_at: now })], []];
      }
      return [resultHeader(), []];
    });

    await expect(
      repository.rotateRefreshToken(
        refreshRecord.tokenDigest,
        { tokenDigest: digest(4), expiresAt: later, createdAt: now },
        expectedContext,
        now,
      ),
    ).resolves.toEqual({ status: 'replayed' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.statement).toMatch(/SET revoked_at = COALESCE/u);
    expect(calls.some((call) => call.statement.includes('INSERT INTO oauth_refresh_token'))).toBe(
      false,
    );
  });

  it('revokes the family on client/resource/scope context mismatch', async () => {
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT t.family_id_digest')) {
        return [[activeRefreshRow()], []];
      }
      return [resultHeader(), []];
    });

    await expect(
      repository.rotateRefreshToken(
        refreshRecord.tokenDigest,
        { tokenDigest: digest(5), expiresAt: later, createdAt: now },
        { ...expectedContext, resource: 'https://wrong.example.test/mcp' },
        now,
      ),
    ).resolves.toEqual({ status: 'invalid' });
    expect(calls[1]?.statement).toMatch(/SET revoked_at = COALESCE/u);
  });

  it('rolls back rotation when replacement persistence fails', async () => {
    const { repository, commit, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT t.family_id_digest')) return [[activeRefreshRow()], []];
      if (statement.includes('INSERT INTO oauth_refresh_token')) throw new Error('insert failed');
      return [resultHeader(), []];
    });

    await expect(
      repository.rotateRefreshToken(
        refreshRecord.tokenDigest,
        { tokenDigest: digest(6), expiresAt: later, createdAt: now },
        expectedContext,
        now,
      ),
    ).rejects.toThrow('insert failed');
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects non-32-byte credential digests before opening a connection', async () => {
    const openConnection = vi.fn(async () => {
      throw new Error('must not connect');
    });
    const repository = new MySqlOAuthRepository({
      openConnection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    });

    await expect(
      repository.storeAuthorizationCode({ ...codeRecord, codeDigest: new Uint8Array(31) }),
    ).rejects.toThrow(OAuthPersistenceError);
    await expect(
      repository.storeRefreshToken({ ...refreshRecord, tokenDigest: new Uint8Array(33) }),
    ).rejects.toThrow(OAuthPersistenceError);
    expect(openConnection).not.toHaveBeenCalled();
  });
});
