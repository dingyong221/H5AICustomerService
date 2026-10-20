import { createHash, randomBytes, scryptSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  MerchantAccessError,
  MySqlMerchantAccessRepository,
} from '../src/merchant-access-repository.js';

const merchantId = Buffer.from('11'.repeat(16), 'hex');
const merchantUserId = Buffer.from('22'.repeat(16), 'hex');
const phoneKey = randomBytes(32).toString('base64url');
const setupToken = randomBytes(32).toString('base64url');
const password = 'a-long-test-password';
const resultHeader = { affectedRows: 1 } as ResultSetHeader;

const repositoryWith = (
  invitationExpired = false,
  revokedRows = 1,
  existingCredential?: { salt: Buffer; hash: Buffer },
) => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const connection = {
    execute: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('FROM merchant_setup_invitation')) {
        return [
          [
            {
              merchant_id: merchantId,
              status: 'pending_owner',
              expires_at: new Date(Date.now() + (invitationExpired ? -1 : 60_000)),
              claimed_at: null,
            },
          ],
          [],
        ];
      }
      if (sql.includes('FROM merchant_password_credential')) {
        return [
          existingCredential
            ? [
                {
                  merchant_user_id: merchantUserId,
                  password_salt: existingCredential.salt,
                  password_hash: existingCredential.hash,
                },
              ]
            : [],
          [],
        ];
      }
      if (sql.includes('FROM platform_login_session')) {
        return [
          [
            {
              merchant_user_id: merchantUserId,
              merchant_id: merchantId,
              expires_at: new Date(Date.now() + 60_000),
              revoked_at: null,
            },
          ],
          [],
        ];
      }
      if (sql.includes('SELECT mm.merchant_id')) return [[{ merchant_id: merchantId }], []];
      if (sql.includes('UPDATE platform_login_session')) {
        return [{ affectedRows: revokedRows } as ResultSetHeader, []];
      }
      return [resultHeader, []];
    },
    beginTransaction: vi.fn(async () => undefined),
    commit,
    rollback,
    end: vi.fn(async () => undefined),
  } as unknown as Connection;
  const database = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  } satisfies DatabaseConnectionConfig;
  return {
    repository: new MySqlMerchantAccessRepository(database, phoneKey),
    calls,
    commit,
    rollback,
  };
};

describe('merchant invitation and scoped session', () => {
  it('accepts fixed account IDs while locking the same credential row used by password resets', async () => {
    const salt = randomBytes(16);
    const f = repositoryWith(false, 1, { salt, hash: scryptSync(password, salt, 64) });
    const session = await f.repository.login({
      phone: `m_${merchantUserId.toString('hex')}`,
      password,
      merchantId: merchantId.toString('hex'),
    });
    expect(session.merchantId).toBe(merchantId.toString('hex'));
    const credential = f.calls.find((call) =>
      call.sql.includes('FROM merchant_password_credential'),
    );
    expect(credential?.sql).toContain('c.merchant_user_id = ?');
    expect(credential?.sql).toContain("u.status = 'active'");
    expect(credential?.sql).toContain('FOR UPDATE');
    expect(credential?.values).toEqual([merchantUserId]);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.rollback).not.toHaveBeenCalled();
  });

  it('rolls back invalid-password logins without issuing a session', async () => {
    const salt = randomBytes(16);
    const f = repositoryWith(false, 1, { salt, hash: scryptSync(password, salt, 64) });
    await expect(
      f.repository.login({
        phone: `m_${merchantUserId.toString('hex')}`,
        password: 'SYNTHETIC-wrong-password',
        merchantId: merchantId.toString('hex'),
      }),
    ).rejects.toThrow('账号、手机号或密码不正确');
    expect(f.calls.some((call) => call.sql.includes('INSERT INTO platform_login_session'))).toBe(
      false,
    );
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.rollback).toHaveBeenCalledOnce();
  });

  it('requires an explicit target when one verified owner has multiple merchants', async () => {
    const merchants = [merchantId, Buffer.from('33'.repeat(16), 'hex')];
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const connection = {
      execute: async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes('FROM merchant_password_credential'))
          return [
            [{ merchant_user_id: merchantUserId, password_salt: salt, password_hash: hash }],
            [],
          ];
        if (sql.includes('SELECT mm.merchant_id')) {
          const target = sql.includes('AND mm.merchant_id = ?') ? (values[1] as Buffer) : null;
          return [
            merchants
              .filter((id) => !target || id.equals(target))
              .map((id) => ({ merchant_id: id })),
            [],
          ];
        }
        return [resultHeader, []];
      },
      beginTransaction: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    } as unknown as Connection;
    const database = {
      openConnection: async () => connection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    } satisfies DatabaseConnectionConfig;
    const repository = new MySqlMerchantAccessRepository(database, phoneKey);
    await expect(repository.login({ phone: '13800138000', password })).rejects.toThrow(
      '请选择有权管理的商家',
    );
    expect(calls.some((call) => call.sql.includes('INSERT INTO platform_login_session'))).toBe(
      false,
    );
    for (const target of merchants) {
      const session = await repository.login({
        phone: '13800138000',
        password,
        merchantId: target.toString('hex'),
      });
      expect(session.merchantId).toBe(target.toString('hex'));
      expect(session.merchantUserId).toBe(merchantUserId.toString('hex'));
    }
    const sessionInserts = calls.filter((call) =>
      call.sql.includes('INSERT INTO platform_login_session'),
    );
    expect(sessionInserts.map((call) => call.values[2])).toEqual(merchants);
    await expect(
      repository.login({ phone: '13800138000', password, merchantId: '44'.repeat(16) }),
    ).rejects.toThrow('请选择有权管理的商家');
    expect(
      calls.filter((call) => call.sql.includes('INSERT INTO platform_login_session')),
    ).toHaveLength(2);
  });
  it('claims one invitation, activates its merchant, and stores only credential digests', async () => {
    const { repository, calls, commit, rollback } = repositoryWith();
    const session = await repository.claimInvitation({
      setupToken,
      phone: '13800138000',
      password,
    });

    expect(session.merchantId).toBe(merchantId.toString('hex'));
    expect(session.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(calls.some((call) => call.sql.includes('INSERT INTO merchant_membership'))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE merchant SET status = 'active'"))).toBe(
      true,
    );
    const sessionInsert = calls.find((call) =>
      call.sql.includes('INSERT INTO platform_login_session'),
    );
    expect(sessionInsert?.sql).toContain('merchant_id');
    expect(sessionInsert?.values[2]).toEqual(merchantId);
    expect(calls.some((call) => JSON.stringify(call.values).includes(setupToken))).toBe(false);
    expect(calls.some((call) => JSON.stringify(call.values).includes(password))).toBe(false);
    expect(calls.some((call) => JSON.stringify(call.values).includes('13800138000'))).toBe(false);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not consume an expired invitation', async () => {
    const { repository, calls, commit, rollback } = repositoryWith(true);
    await expect(
      repository.claimInvitation({ setupToken, phone: '13800138000', password }),
    ).rejects.toBeInstanceOf(MerchantAccessError);
    expect(calls.some((call) => call.sql.includes('INSERT INTO merchant_membership'))).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('reuses an existing owner only after asynchronous password verification', async () => {
    const salt = randomBytes(16);
    const existingCredential = { salt, hash: scryptSync(password, salt, 64) };
    const { repository, calls, commit } = repositoryWith(false, 1, existingCredential);
    const session = await repository.claimInvitation({
      setupToken,
      phone: '13800138000',
      password,
    });
    expect(session.merchantUserId).toBe(merchantUserId.toString('hex'));
    expect(calls.some((call) => call.sql.includes('INSERT INTO merchant_user'))).toBe(false);
    expect(commit).toHaveBeenCalledOnce();

    const rejected = repositoryWith(false, 1, existingCredential);
    await expect(
      rejected.repository.claimInvitation({
        setupToken,
        phone: '13800138000',
        password: 'another-long-password',
      }),
    ).rejects.toThrow('此手机号已有账号');
    expect(
      rejected.calls.some((call) => call.sql.includes('INSERT INTO merchant_membership')),
    ).toBe(false);
    expect(rejected.rollback).toHaveBeenCalledOnce();
  });

  it('resolves a valid session only through the merchant bound when issued', async () => {
    const { repository, calls } = repositoryWith();
    const sessionToken = randomBytes(32).toString('base64url');
    const resolved = await repository.resolveSession(sessionToken, merchantId.toString('hex'));
    expect(resolved?.merchantId).toBe(merchantId.toString('hex'));
    const lookup = calls.find((call) => call.sql.includes('FROM platform_login_session'));
    expect(lookup?.sql).toContain('mm.merchant_id = s.merchant_id');
    expect(lookup?.sql).toContain('mm.merchant_id = ?');
    expect(lookup?.values[1]).toEqual(merchantId);
  });

  it('binds sensitive writes to the CSRF token stored with the login session', async () => {
    const { repository, calls } = repositoryWith();
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    await repository.resolveSession(sessionToken, merchantId.toString('hex'), csrfToken);
    const lookup = calls.find((call) => call.sql.includes('FROM platform_login_session'));
    expect(lookup?.sql).toContain('s.csrf_digest = ?');
    expect(lookup?.values[1]).toEqual(createHash('sha256').update(csrfToken, 'ascii').digest());
    expect(lookup?.values[2]).toEqual(merchantId);
    expect(
      await repository.resolveSession(sessionToken, merchantId.toString('hex'), 'invalid'),
    ).toBeNull();
  });

  it('revokes only the matching merchant session and CSRF pair without storing raw tokens', async () => {
    const { repository, calls } = repositoryWith();
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    await expect(
      repository.revokeSession(sessionToken, csrfToken, merchantId.toString('hex')),
    ).resolves.toBe(true);
    const update = calls.find((call) => call.sql.includes('UPDATE platform_login_session'));
    expect(update?.sql).toContain('session_digest = ? AND csrf_digest = ? AND merchant_id = ?');
    expect(update?.sql).toContain("authentication_level = 'primary'");
    expect(update?.sql).toContain('revoked_at IS NULL');
    expect(update?.values).toEqual([
      createHash('sha256').update(sessionToken, 'ascii').digest(),
      createHash('sha256').update(csrfToken, 'ascii').digest(),
      merchantId,
    ]);
    expect(JSON.stringify(update?.values)).not.toContain(sessionToken);
    expect(JSON.stringify(update?.values)).not.toContain(csrfToken);
    await expect(
      repository.revokeSession('invalid', csrfToken, merchantId.toString('hex')),
    ).rejects.toBeInstanceOf(MerchantAccessError);
    expect(calls.filter((call) => call.sql.includes('UPDATE platform_login_session'))).toHaveLength(
      1,
    );
  });

  it('treats an already revoked or missing merchant session as an idempotent logout', async () => {
    const { repository } = repositoryWith(false, 0);
    await expect(
      repository.revokeSession(
        randomBytes(32).toString('base64url'),
        randomBytes(32).toString('base64url'),
        merchantId.toString('hex'),
      ),
    ).resolves.toBe(false);
  });
});
