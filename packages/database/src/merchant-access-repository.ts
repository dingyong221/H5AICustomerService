import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';

type InviteRow = RowDataPacket & {
  merchant_id: Buffer;
  status: string;
  expires_at: Date;
  claimed_at: Date | null;
};

type CredentialRow = RowDataPacket & {
  merchant_user_id: Buffer;
  password_salt: Buffer;
  password_hash: Buffer;
};

type MembershipRow = RowDataPacket & { merchant_id: Buffer };

type SessionRow = RowDataPacket & {
  merchant_user_id: Buffer;
  merchant_id: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
};

export type MerchantSession = Readonly<{
  merchantId: string;
  merchantUserId: string;
}>;

export type MerchantSessionIssued = MerchantSession &
  Readonly<{
    sessionToken: string;
    csrfToken: string;
    expiresAt: Date;
  }>;

export class MerchantAccessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MerchantAccessError';
  }
}

export const tokenDigest = (value: string): Buffer =>
  createHash('sha256').update(value, 'ascii').digest();
export const derivePassword = (password: string, salt: Buffer, length: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, length, (error, key) => (error ? reject(error) : resolve(key)));
  });

const hexId = (value: string): Buffer => {
  if (!/^[0-9a-f]{32}$/iu.test(value)) throw new MerchantAccessError('Merchant ID is invalid');
  return Buffer.from(value, 'hex');
};

export const phoneNumber = (value: string): string => {
  const compact = value.replace(/[\s-]/gu, '');
  const normalized = compact.startsWith('+86') ? compact.slice(3) : compact;
  if (!/^1[3-9][0-9]{9}$/u.test(normalized)) {
    throw new MerchantAccessError('请输入有效的中国大陆手机号');
  }
  return `+86${normalized}`;
};

export const passwordValue = (value: string): string => {
  if (value.length < 12 || value.length > 128) {
    throw new MerchantAccessError('密码须为 12–128 个字符');
  }
  return value;
};

export const comparePassword = async (password: string, row: CredentialRow): Promise<boolean> => {
  if (row.password_salt.byteLength !== 16 || row.password_hash.byteLength !== 64) {
    throw new MerchantAccessError('Stored password credential is invalid');
  }
  const actual = await derivePassword(password, row.password_salt, 64);
  return timingSafeEqual(actual, row.password_hash);
};

export class MySqlMerchantAccessRepository {
  readonly #database: DatabaseConnectionConfig;
  readonly #phoneKey: Buffer;

  public constructor(database: DatabaseConnectionConfig, phoneLookupKey: string) {
    const key = Buffer.from(phoneLookupKey, 'base64url');
    if (key.byteLength < 32 || !/^[A-Za-z0-9_-]+$/u.test(phoneLookupKey)) {
      throw new MerchantAccessError('Phone lookup key is not configured');
    }
    this.#database = database;
    this.#phoneKey = key;
  }

  #phoneDigest(phone: string): Buffer {
    return createHmac('sha256', this.#phoneKey).update(phoneNumber(phone), 'utf8').digest();
  }

  public async claimInvitation(input: {
    setupToken: string;
    phone: string;
    password: string;
  }): Promise<MerchantSessionIssued> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.setupToken)) {
      throw new MerchantAccessError('领取链接无效');
    }
    const phoneDigest = this.#phoneDigest(input.phone);
    const password = passwordValue(input.password);
    const connection = await this.#database.openConnection();
    try {
      await connection.beginTransaction();
      try {
        const [invites] = await connection.execute<InviteRow[]>(
          `SELECT i.merchant_id, i.expires_at, i.claimed_at, m.status
             FROM merchant_setup_invitation i
             JOIN merchant m ON m.id = i.merchant_id
            WHERE i.token_digest = ?
            LIMIT 1 FOR UPDATE`,
          [tokenDigest(input.setupToken)],
        );
        const invite = invites[0];
        if (
          !invite ||
          invite.claimed_at !== null ||
          invite.expires_at.getTime() <= Date.now() ||
          invite.status !== 'pending_owner'
        ) {
          throw new MerchantAccessError('领取链接已失效');
        }

        const [credentials] = await connection.execute<CredentialRow[]>(
          `SELECT merchant_user_id, password_salt, password_hash
             FROM merchant_password_credential
            WHERE phone_lookup_digest = ? LIMIT 1 FOR UPDATE`,
          [phoneDigest],
        );
        let merchantUserId = credentials[0]?.merchant_user_id;
        if (credentials[0]) {
          if (!(await comparePassword(password, credentials[0]))) {
            throw new MerchantAccessError('此手机号已有账号，请使用原密码领取');
          }
        } else {
          merchantUserId = randomBytes(16);
          const salt = randomBytes(16);
          const hash = await derivePassword(password, salt, 64);
          await connection.execute(
            `INSERT INTO merchant_user (id, status, created_at, updated_at)
             VALUES (?, 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
            [merchantUserId],
          );
          await connection.execute(
            `INSERT INTO merchant_password_credential
               (merchant_user_id, phone_lookup_digest, password_salt, password_hash,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
            [merchantUserId, phoneDigest, salt, hash],
          );
        }
        if (!merchantUserId) throw new MerchantAccessError('商家账号创建失败');
        await connection.execute(
          `INSERT INTO merchant_membership
             (merchant_id, merchant_user_id, role, status, created_at, updated_at)
           VALUES (?, ?, 'owner', 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [invite.merchant_id, merchantUserId],
        );
        const [merchantUpdate] = await connection.execute<ResultSetHeader>(
          `UPDATE merchant SET status = 'active', updated_at = UTC_TIMESTAMP(6)
            WHERE id = ? AND status = 'pending_owner'`,
          [invite.merchant_id],
        );
        if (merchantUpdate.affectedRows !== 1) throw new MerchantAccessError('商家状态已变更');
        await connection.execute(
          `UPDATE merchant_setup_invitation SET claimed_at = UTC_TIMESTAMP(6)
            WHERE token_digest = ? AND claimed_at IS NULL`,
          [tokenDigest(input.setupToken)],
        );
        const session = await this.#issueSession(connection, merchantUserId, invite.merchant_id);
        await connection.execute(
          `INSERT INTO audit_log
             (id, merchant_id, actor_type, actor_id, action, target_type, target_id,
              result, request_id, occurred_at, created_at)
           VALUES (?, ?, 'merchant_user', ?, 'merchant.claim', 'merchant', ?,
                   'success', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [
            randomBytes(16),
            invite.merchant_id,
            merchantUserId.toString('hex'),
            invite.merchant_id.toString('hex'),
            randomBytes(16).toString('hex'),
          ],
        );
        await connection.commit();
        return session;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      await connection.end();
    }
  }

  public async login(input: {
    phone: string;
    password: string;
    merchantId?: string;
  }): Promise<MerchantSessionIssued> {
    const account = /^m_[0-9a-f]{32}$/u.test(input.phone) ? input.phone.slice(2) : null;
    const lookup = account ? hexId(account) : this.#phoneDigest(input.phone);
    const password = passwordValue(input.password);
    const connection = await this.#database.openConnection();
    try {
      await connection.beginTransaction();
      const [credentials] = await connection.execute<CredentialRow[]>(
        `SELECT c.merchant_user_id, c.password_salt, c.password_hash
           FROM merchant_password_credential c
           JOIN merchant_user u ON u.id = c.merchant_user_id
          WHERE ${account ? 'c.merchant_user_id' : 'c.phone_lookup_digest'} = ? AND u.status = 'active' LIMIT 1 FOR UPDATE`,
        [lookup],
      );
      const credential = credentials[0];
      if (!credential || !(await comparePassword(password, credential))) {
        throw new MerchantAccessError('账号、手机号或密码不正确');
      }
      const parameters: Buffer[] = [credential.merchant_user_id];
      let merchantFilter = '';
      if (input.merchantId) {
        merchantFilter = ' AND mm.merchant_id = ?';
        parameters.push(hexId(input.merchantId));
      }
      const [memberships] = await connection.execute<MembershipRow[]>(
        `SELECT mm.merchant_id FROM merchant_membership mm
           JOIN merchant m ON m.id = mm.merchant_id
          WHERE mm.merchant_user_id = ? AND mm.status = 'active' AND m.status = 'active'
          ${merchantFilter} ORDER BY mm.created_at ASC LIMIT 2`,
        parameters,
      );
      if (memberships.length !== 1) {
        throw new MerchantAccessError('请选择有权管理的商家');
      }
      const session = await this.#issueSession(
        connection,
        credential.merchant_user_id,
        memberships[0]!.merchant_id,
      );
      await connection.commit();
      return session;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  public async resolveSessionIdentity(
    rawToken: string,
    merchantId?: string,
  ): Promise<MerchantSession | null> {
    return this.#resolveSession(rawToken, merchantId, undefined, false);
  }

  public async resolveSession(
    rawToken: string,
    merchantId?: string,
    rawCsrfToken?: string,
  ): Promise<MerchantSession | null> {
    return this.#resolveSession(rawToken, merchantId, rawCsrfToken, true);
  }

  async #resolveSession(
    rawToken: string,
    merchantId: string | undefined,
    rawCsrfToken: string | undefined,
    requireEntitlement: boolean,
  ): Promise<MerchantSession | null> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(rawToken)) return null;
    if (rawCsrfToken !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(rawCsrfToken)) return null;
    const connection = await this.#database.openConnection();
    try {
      const parameters: Buffer[] = [tokenDigest(rawToken)];
      const csrfFilter = rawCsrfToken === undefined ? '' : ' AND s.csrf_digest = ?';
      if (rawCsrfToken !== undefined) parameters.push(tokenDigest(rawCsrfToken));
      let merchantFilter = '';
      if (merchantId) {
        merchantFilter = ' AND mm.merchant_id = ?';
        parameters.push(hexId(merchantId));
      }
      const [rows] = await connection.execute<SessionRow[]>(
        `SELECT s.merchant_user_id, mm.merchant_id, s.expires_at, s.revoked_at
           FROM platform_login_session s
           JOIN merchant_user u ON u.id = s.merchant_user_id
           JOIN merchant_membership mm
             ON mm.merchant_user_id = s.merchant_user_id AND mm.merchant_id = s.merchant_id
           JOIN merchant m ON m.id = mm.merchant_id
          WHERE s.session_digest = ? AND s.authentication_level = 'primary'
            ${csrfFilter}
            AND u.status = 'active' AND mm.status = 'active' AND m.status = 'active'
            ${requireEntitlement ? "AND NOT EXISTS (SELECT 1 FROM marketplace_allocation ma JOIN marketplace_entitlement me ON me.subject_digest = ma.subject_digest AND me.product = ma.product WHERE ma.merchant_id = m.id AND (me.status <> 'active' OR me.valid_from > UTC_TIMESTAMP(6) OR me.expires_at <= UTC_TIMESTAMP(6)))" : ''}
            ${merchantFilter}
          LIMIT 2`,
        parameters,
      );
      if (
        rows.length !== 1 ||
        rows[0]!.revoked_at !== null ||
        rows[0]!.expires_at.getTime() <= Date.now()
      ) {
        return null;
      }
      return {
        merchantId: rows[0]!.merchant_id.toString('hex'),
        merchantUserId: rows[0]!.merchant_user_id.toString('hex'),
      };
    } finally {
      await connection.end();
    }
  }

  public async revokeSession(
    rawToken: string,
    rawCsrfToken: string,
    merchantId: string,
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(rawToken) || !/^[A-Za-z0-9_-]{43}$/u.test(rawCsrfToken)) {
      throw new MerchantAccessError('Session credential is invalid');
    }
    const merchantIdBuffer = hexId(merchantId);
    const connection = await this.#database.openConnection();
    try {
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE platform_login_session
            SET revoked_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)
          WHERE session_digest = ? AND csrf_digest = ? AND merchant_id = ?
            AND authentication_level = 'primary' AND revoked_at IS NULL`,
        [tokenDigest(rawToken), tokenDigest(rawCsrfToken), merchantIdBuffer],
      );
      return updated.affectedRows === 1;
    } finally {
      await connection.end();
    }
  }

  async #issueSession(
    connection: Connection,
    merchantUserId: Buffer,
    merchantId: Buffer,
  ): Promise<MerchantSessionIssued> {
    return issueMerchantSession(connection, merchantUserId, merchantId);
  }
}

/** Shared primary-session transaction primitive; caller must authenticate first. */
export async function issueMerchantSession(
  connection: Connection,
  merchantUserId: Buffer,
  merchantId: Buffer,
): Promise<MerchantSessionIssued> {
  const sessionToken = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1_000);
  await connection.execute(
    `INSERT INTO platform_login_session
         (session_digest, merchant_user_id, merchant_id, csrf_digest, authentication_level,
          authenticated_at, expires_at, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'primary', UTC_TIMESTAMP(6), ?, NULL,
               UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
    [tokenDigest(sessionToken), merchantUserId, merchantId, tokenDigest(csrfToken), expiresAt],
  );
  return {
    merchantId: merchantId.toString('hex'),
    merchantUserId: merchantUserId.toString('hex'),
    sessionToken,
    csrfToken,
    expiresAt,
  };
}
