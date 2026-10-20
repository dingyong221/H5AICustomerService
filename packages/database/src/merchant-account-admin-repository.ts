import { createHash, randomBytes, scrypt } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';

export type MerchantManagedAccount = Readonly<{
  userId: string;
  account: string;
  role: string;
  status: string;
  version: string;
  relatedMerchants: readonly { id: string; name: string }[];
}>;
type AccountRow = RowDataPacket & {
  user_id: Buffer;
  role: string;
  status: string;
  password_salt: Buffer;
};
type RelatedRow = RowDataPacket & { id: Buffer; name: string };
type RelatedIdRow = RowDataPacket & { id: Buffer };
export const merchantPasswordResetReasons = [
  '忘记密码',
  '商家申请',
  '安全处理',
  '其他人工核对',
] as const;
export const isMerchantPasswordResetReason = (value: string): boolean =>
  merchantPasswordResetReasons.some((reason) => reason === value);
const id = (value: string) => {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new Error('Invalid account scope');
  return Buffer.from(value, 'hex');
};
const version = (salt: Buffer) => createHash('sha256').update(salt).digest('hex');
export class AccountResetConflict extends Error {}

export class MySqlMerchantAccountAdminRepository {
  constructor(private readonly config: DatabaseConnectionConfig) {}
  async list(merchantId: string): Promise<readonly MerchantManagedAccount[]> {
    const merchant = id(merchantId);
    const connection = await this.config.openConnection();
    try {
      await connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.execute('START TRANSACTION READ ONLY');
      const [rows] = await connection.execute<AccountRow[]>(
        `SELECT u.id user_id, mm.role, u.status, c.password_salt
         FROM merchant_membership mm JOIN merchant_user u ON u.id = mm.merchant_user_id
         JOIN merchant_password_credential c ON c.merchant_user_id = u.id
         WHERE mm.merchant_id = ? AND mm.status = 'active' ORDER BY mm.created_at, u.id LIMIT 51`,
        [merchant],
      );
      if (rows.length > 50) throw new Error('Account scope too large');
      const accounts: MerchantManagedAccount[] = [];
      for (const row of rows) {
        const [related] = await connection.execute<RelatedRow[]>(
          `SELECT m.id, m.name FROM merchant_membership mm JOIN merchant m ON m.id = mm.merchant_id
           WHERE mm.merchant_user_id = ? AND mm.status = 'active' ORDER BY m.id LIMIT 101`,
          [row.user_id],
        );
        if (related.length > 100) throw new Error('Account scope too large');
        accounts.push({
          userId: row.user_id.toString('hex'),
          account: `m_${row.user_id.toString('hex')}`,
          role: row.role,
          status: row.status,
          version: version(row.password_salt),
          relatedMerchants: related.map((item) => ({
            id: item.id.toString('hex'),
            name: item.name,
          })),
        });
      }
      await connection.commit();
      return accounts;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  async reset(input: {
    merchantId: string;
    userId: string;
    expectedVersion: string;
    affectedMerchantIds: readonly string[];
    password: string;
    reason: string;
    operatorId: string;
  }) {
    const merchant = id(input.merchantId),
      user = id(input.userId);
    if (
      !/^[0-9a-f]{64}$/u.test(input.expectedVersion) ||
      input.password.length < 12 ||
      input.password.length > 128 ||
      !isMerchantPasswordResetReason(input.reason) ||
      !input.operatorId ||
      input.operatorId.length > 128 ||
      input.affectedMerchantIds.length < 1 ||
      input.affectedMerchantIds.length > 100
    )
      throw new Error('Invalid reset');
    const expected = [...new Set(input.affectedMerchantIds)].sort();
    expected.forEach(id);
    if (expected.length !== input.affectedMerchantIds.length) throw new Error('Invalid reset');
    const salt = randomBytes(16);
    const hash = await new Promise<Buffer>((resolve, reject) =>
      scrypt(input.password, salt, 64, (error, value) => (error ? reject(error) : resolve(value))),
    );
    const connection = await this.config.openConnection();
    try {
      await connection.beginTransaction();
      // Same credential lock as login: an old-password login cannot issue a new
      // session after the reset has committed.
      const [accounts] = await connection.execute<AccountRow[]>(
        `SELECT c.merchant_user_id user_id, c.password_salt, u.status FROM merchant_password_credential c
         JOIN merchant_user u ON u.id = c.merchant_user_id WHERE c.merchant_user_id = ? FOR UPDATE`,
        [user],
      );
      const account = accounts[0];
      if (
        !account ||
        account.status !== 'active' ||
        version(account.password_salt) !== input.expectedVersion
      )
        throw new AccountResetConflict();
      // Do not lock joined merchant rows: invitation claiming already holds its
      // merchant before taking this credential lock. Lock the memberships only.
      const [related] = await connection.execute<RelatedIdRow[]>(
        `SELECT mm.merchant_id id FROM merchant_membership mm
         WHERE mm.merchant_user_id = ? AND mm.status = 'active' ORDER BY mm.merchant_id LIMIT 101 FOR UPDATE`,
        [user],
      );
      const actual = related.map((row) => row.id.toString('hex')).sort();
      if (
        !actual.includes(merchant.toString('hex')) ||
        JSON.stringify(actual) !== JSON.stringify(expected)
      )
        throw new AccountResetConflict();
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE merchant_password_credential SET password_salt = ?, password_hash = ?, updated_at = UTC_TIMESTAMP(6) WHERE merchant_user_id = ?`,
        [salt, hash, user],
      );
      if (updated.affectedRows !== 1) throw new AccountResetConflict();
      await connection.execute(
        `UPDATE platform_login_session SET revoked_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6) WHERE merchant_user_id = ? AND revoked_at IS NULL`,
        [user],
      );
      for (const relatedMerchant of related)
        await connection.execute(
          `INSERT INTO audit_log (id, merchant_id, actor_type, actor_id, action, target_type, target_id,
          result, request_id, metadata, occurred_at, created_at)
         VALUES (?, ?, 'platform_operator', ?, 'merchant.password_reset', 'merchant_user', ?, 'success', ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [
            randomBytes(16),
            relatedMerchant.id,
            input.operatorId,
            input.userId,
            randomBytes(16).toString('hex'),
            JSON.stringify({
              reason: input.reason,
              affectedMerchantIds: actual,
              sessionsRevoked: true,
            }),
          ],
        );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }
}
