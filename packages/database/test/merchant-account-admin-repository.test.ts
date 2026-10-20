import { createHash, randomBytes, scryptSync } from 'node:crypto';
import type { Connection, ResultSetHeader } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  AccountResetConflict,
  isMerchantPasswordResetReason,
  merchantPasswordResetReasons,
  MySqlMerchantAccountAdminRepository,
} from '../src/merchant-account-admin-repository.js';

const merchant = '11'.repeat(16),
  otherMerchant = '22'.repeat(16),
  user = '33'.repeat(16);
const salt = randomBytes(16);
const version = createHash('sha256').update(salt).digest('hex');
const validInput = () => ({
  merchantId: merchant,
  userId: user,
  expectedVersion: version,
  affectedMerchantIds: [merchant, otherMerchant],
  password: 'SYNTHETIC-new-password-123',
  reason: '忘记密码',
  operatorId: 'synthetic-operator',
});
const fixture = (
  options: {
    status?: string;
    versionSalt?: Buffer;
    noAccount?: boolean;
    scope?: string[];
    accountCount?: number;
    affectedRows?: number;
    failAudit?: boolean;
  } = {},
) => {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const commit = vi.fn(async () => undefined),
    rollback = vi.fn(async () => undefined);
  const beginTransaction = vi.fn(async () => undefined),
    end = vi.fn(async () => undefined);
  const query = vi.fn(async (_sql: string) => [{ affectedRows: 0 } as ResultSetHeader, []]);
  const connection = {
    execute: async (sql: string, values: readonly unknown[] = []) => {
      if (/^(?:START|SET) TRANSACTION/u.test(sql))
        throw new Error('ER_UNSUPPORTED_PS: transaction-control statements require query()');
      calls.push({ sql, values });
      if (
        sql.includes('SELECT u.id user_id') ||
        sql.includes('SELECT c.merchant_user_id user_id')
      ) {
        return [
          options.noAccount
            ? []
            : Array.from({ length: options.accountCount ?? 1 }, () => ({
                user_id: Buffer.from(user, 'hex'),
                role: 'owner',
                status: options.status ?? 'active',
                password_salt: options.versionSalt ?? salt,
              })),
          [],
        ];
      }
      if (sql.includes('FROM merchant_membership mm')) {
        return [
          (options.scope ?? [merchant, otherMerchant]).map((value, index) => ({
            id: Buffer.from(value, 'hex'),
            name: `Synthetic merchant ${index}`,
          })),
          [],
        ];
      }
      if (sql.includes('INSERT INTO audit_log') && options.failAudit)
        throw new Error('synthetic failure');
      return [{ affectedRows: options.affectedRows ?? 1 } as ResultSetHeader, []];
    },
    query,
    beginTransaction,
    commit,
    rollback,
    end,
  } as unknown as Connection;
  const openConnection = vi.fn(async () => connection);
  const database = {
    openConnection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  } satisfies DatabaseConnectionConfig;
  return {
    repository: new MySqlMerchantAccountAdminRepository(database),
    calls,
    query,
    openConnection,
    beginTransaction,
    commit,
    rollback,
    end,
  };
};

describe('operator merchant account management', () => {
  it('lists stable login accounts without phone digests, password hashes, or salts', async () => {
    const f = fixture();
    const accounts = await f.repository.list(merchant);
    expect(accounts).toEqual([
      {
        userId: user,
        account: `m_${user}`,
        role: 'owner',
        status: 'active',
        version,
        relatedMerchants: [
          { id: merchant, name: 'Synthetic merchant 0' },
          { id: otherMerchant, name: 'Synthetic merchant 1' },
        ],
      },
    ]);
    expect(JSON.stringify(accounts)).not.toMatch(
      /password_hash|password_salt|phone_lookup_digest/u,
    );
    const lookup = f.calls.find((call) => call.sql.includes('SELECT u.id user_id'));
    expect(lookup?.values).toEqual([Buffer.from(merchant, 'hex')]);
    expect(lookup?.sql).toContain("mm.status = 'active'");
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.end).toHaveBeenCalledOnce();
  });

  it('sends read-only transaction setup through the text query protocol, never prepared execute', async () => {
    const f = fixture();
    await f.repository.list(merchant);
    expect(f.query).toHaveBeenNthCalledWith(1, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    expect(f.query).toHaveBeenNthCalledWith(2, 'START TRANSACTION READ ONLY');
    expect(f.calls).toHaveLength(2);
    expect(f.calls.every((call) => call.sql.trimStart().startsWith('SELECT'))).toBe(true);
    expect(f.calls[0]?.values).toEqual([Buffer.from(merchant, 'hex')]);
    expect(f.calls[1]?.values).toEqual([Buffer.from(user, 'hex')]);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.rollback).not.toHaveBeenCalled();
  });

  it('does not silently truncate account or related-merchant scope', async () => {
    const overAccounts = fixture({ accountCount: 51 });
    await expect(overAccounts.repository.list(merchant)).rejects.toThrow('Account scope too large');
    expect(overAccounts.rollback).toHaveBeenCalledOnce();
    const overScope = fixture({ scope: Array.from({ length: 101 }, () => merchant) });
    await expect(overScope.repository.list(merchant)).rejects.toThrow('Account scope too large');
    expect(overScope.rollback).toHaveBeenCalledOnce();
    expect(overScope.end).toHaveBeenCalledOnce();
  });

  it('rejects invalid merchant IDs before connecting', async () => {
    const f = fixture();
    await expect(f.repository.list('invalid')).rejects.toThrow('Invalid account scope');
    expect(f.openConnection).not.toHaveBeenCalled();
  });

  it('locks the credential, verifies every related merchant, rotates the hash, and revokes all sessions atomically', async () => {
    const f = fixture(),
      input = validInput();
    await f.repository.reset(input);
    expect(f.beginTransaction).toHaveBeenCalledOnce();
    expect(f.calls[0]?.sql).toContain('merchant_password_credential');
    expect(f.calls[0]?.sql).toContain('FOR UPDATE');
    expect(f.calls[0]?.values).toEqual([Buffer.from(user, 'hex')]);
    const scope = f.calls.find((call) => call.sql.includes('FROM merchant_membership mm'));
    expect(scope?.sql).toContain('FOR UPDATE');
    expect(scope?.sql).not.toContain('JOIN merchant m');
    const update = f.calls.find((call) =>
      call.sql.includes('UPDATE merchant_password_credential'),
    )!;
    const newSalt = update.values[0] as Buffer,
      hash = update.values[1] as Buffer;
    expect(newSalt.length).toBe(16);
    expect(hash.length).toBe(64);
    expect(hash.equals(scryptSync(input.password, newSalt, 64))).toBe(true);
    expect(newSalt.equals(salt)).toBe(false);
    expect(update.values[2]).toEqual(Buffer.from(user, 'hex'));
    const revoke = f.calls.find((call) => call.sql.includes('UPDATE platform_login_session'));
    expect(revoke?.values).toEqual([Buffer.from(user, 'hex')]);
    expect(revoke?.sql).toContain('revoked_at IS NULL');
    expect(revoke?.sql).not.toContain('merchant_id =');
    const audit = f.calls.filter((call) => call.sql.includes('INSERT INTO audit_log'));
    expect(audit).toHaveLength(2);
    expect(audit.map((call) => call.values[1])).toEqual([
      Buffer.from(merchant, 'hex'),
      Buffer.from(otherMerchant, 'hex'),
    ]);
    for (const call of audit) {
      expect(JSON.parse(call.values[5] as string)).toEqual({
        reason: '忘记密码',
        affectedMerchantIds: [merchant, otherMerchant],
        sessionsRevoked: true,
      });
      expect(JSON.stringify(call.values)).not.toContain(input.password);
      expect(JSON.stringify(call.values)).not.toContain(hash.toString('hex'));
    }
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.end).toHaveBeenCalledOnce();
  });

  it.each([
    { noAccount: true },
    { status: 'suspended' },
    { versionSalt: randomBytes(16) },
    { scope: [otherMerchant] },
    { scope: [merchant] },
    { scope: [merchant, otherMerchant, '44'.repeat(16)] },
  ])('fails closed on stale account or shared-account scope %j', async (options) => {
    const f = fixture(options);
    await expect(f.repository.reset(validInput())).rejects.toBeInstanceOf(AccountResetConflict);
    expect(f.calls.some((call) => call.sql.startsWith('UPDATE'))).toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.rollback).toHaveBeenCalledOnce();
    expect(f.end).toHaveBeenCalledOnce();
  });

  it('does not commit the password or revocation when auditing fails', async () => {
    const f = fixture({ failAudit: true });
    await expect(f.repository.reset(validInput())).rejects.toThrow('synthetic failure');
    expect(f.calls.some((call) => call.sql.includes('UPDATE platform_login_session'))).toBe(true);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.rollback).toHaveBeenCalledOnce();
  });

  it('rejects an unexpected credential update result', async () => {
    const f = fixture({ affectedRows: 0 });
    await expect(f.repository.reset(validInput())).rejects.toBeInstanceOf(AccountResetConflict);
    expect(f.calls.some((call) => call.sql.includes('UPDATE platform_login_session'))).toBe(false);
    expect(f.rollback).toHaveBeenCalledOnce();
  });

  it.each([
    { merchantId: 'invalid' },
    { userId: 'invalid' },
    { expectedVersion: 'bad' },
    { password: 'short' },
    { password: 'a'.repeat(129) },
    { reason: 'new password was pasted here' },
    { reason: ' 忘记密码' },
    { operatorId: '' },
    { affectedMerchantIds: [] },
    { affectedMerchantIds: [merchant, merchant] },
    { affectedMerchantIds: ['invalid'] },
  ])('rejects malformed reset input before connecting %j', async (override) => {
    const f = fixture();
    await expect(f.repository.reset({ ...validInput(), ...override })).rejects.toThrow();
    expect(f.openConnection).not.toHaveBeenCalled();
  });

  it('uses only controlled audit reasons rather than arbitrary notes or pasted secrets', () => {
    expect(merchantPasswordResetReasons).toEqual([
      '忘记密码',
      '商家申请',
      '安全处理',
      '其他人工核对',
    ]);
    for (const reason of merchantPasswordResetReasons)
      expect(isMerchantPasswordResetReason(reason)).toBe(true);
    expect(isMerchantPasswordResetReason(validInput().password)).toBe(false);
    expect(isMerchantPasswordResetReason('忘记密码；密码为秘密')).toBe(false);
  });
});
