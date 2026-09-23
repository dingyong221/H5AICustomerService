import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import { MerchantAccessError, MySqlMerchantAccessRepository } from '../src/merchant-access-repository.js';

const merchantId = Buffer.from('11'.repeat(16), 'hex');
const merchantUserId = Buffer.from('22'.repeat(16), 'hex');
const phoneKey = randomBytes(32).toString('base64url');
const setupToken = randomBytes(32).toString('base64url');
const password = 'a-long-test-password';
const resultHeader = { affectedRows: 1 } as ResultSetHeader;

const repositoryWith = (invitationExpired = false) => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const connection = {
    execute: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('FROM merchant_setup_invitation')) {
        return [[{
          merchant_id: merchantId,
          status: 'pending_owner',
          expires_at: new Date(Date.now() + (invitationExpired ? -1 : 60_000)),
          claimed_at: null,
        }], []];
      }
      if (sql.includes('FROM merchant_password_credential')) return [[], []];
      if (sql.includes('FROM platform_login_session')) {
        return [[{
          merchant_user_id: merchantUserId,
          merchant_id: merchantId,
          expires_at: new Date(Date.now() + 60_000),
          revoked_at: null,
        }], []];
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
  return { repository: new MySqlMerchantAccessRepository(database, phoneKey), calls, commit, rollback };
};

describe('merchant invitation and scoped session', () => {
  it('claims one invitation, activates its merchant, and stores only credential digests', async () => {
    const { repository, calls, commit, rollback } = repositoryWith();
    const session = await repository.claimInvitation({ setupToken, phone: '13800138000', password });

    expect(session.merchantId).toBe(merchantId.toString('hex'));
    expect(session.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(calls.some((call) => call.sql.includes("INSERT INTO merchant_membership"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE merchant SET status = 'active'"))).toBe(true);
    const sessionInsert = calls.find((call) => call.sql.includes('INSERT INTO platform_login_session'));
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
    await expect(repository.claimInvitation({ setupToken, phone: '13800138000', password }))
      .rejects.toBeInstanceOf(MerchantAccessError);
    expect(calls.some((call) => call.sql.includes('INSERT INTO merchant_membership'))).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
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
});
