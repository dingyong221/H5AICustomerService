import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Connection, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';

export type ProvisionedMerchant = Readonly<{
  id: string;
  name: string;
  status: 'pending_owner';
  setupToken: string;
  setupExpiresAt: Date;
}>;

export class MerchantInvitationNotReissuableError extends Error {
  public constructor() {
    super('Merchant invitation cannot be reissued');
    this.name = 'MerchantInvitationNotReissuableError';
  }
}

export type PlatformMerchantSummary = Readonly<{
  id: string;
  name: string;
  status: string;
  createdAt: Date;
}>;

type MerchantRow = RowDataPacket & {
  id: Buffer;
  name: string;
  status: string;
  created_at: Date;
};

type PendingMerchantRow = RowDataPacket & { name: string; status: string };

const validName = (name: string): string => {
  const value = name.trim();
  if (value.length < 2 || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Merchant name must contain 2–200 printable characters');
  }
  return value;
};

const validOperator = (operator: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(operator)) {
    throw new Error('Platform operator ID is invalid');
  }
  return operator;
};

export class MySqlPlatformProvisioningRepository {
  readonly #database: DatabaseConnectionConfig;

  public constructor(database: DatabaseConnectionConfig) {
    this.#database = database;
  }

  public async listMerchants(limit = 50): Promise<readonly PlatformMerchantSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Merchant list limit is invalid');
    }
    const connection = await this.#database.openConnection();
    try {
      const [rows] = await connection.execute<MerchantRow[]>(
        `SELECT id, name, status, created_at
           FROM merchant
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        [limit],
      );
      return rows.map((row) => ({
        id: row.id.toString('hex'),
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
      }));
    } finally {
      await connection.end();
    }
  }

  public async provisionMerchant(input: {
    name: string;
    operatorId: string;
    requestId?: string;
  }): Promise<ProvisionedMerchant> {
    const name = validName(input.name);
    const operatorId = validOperator(input.operatorId);
    const merchantId = randomBytes(16);
    const setupToken = randomBytes(32).toString('base64url');
    const tokenDigest = createHash('sha256').update(setupToken, 'ascii').digest();
    const setupExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const requestId = input.requestId ?? randomUUID();
    if (requestId.length === 0 || requestId.length > 128) {
      throw new Error('Request ID is invalid');
    }

    const connection = await this.#database.openConnection();
    try {
      await connection.beginTransaction();
      try {
        await this.#insertProvisioningRecords(connection, {
          merchantId,
          name,
          operatorId,
          requestId,
          setupExpiresAt,
          tokenDigest,
        });
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      await connection.end();
    }

    return {
      id: merchantId.toString('hex'),
      name,
      status: 'pending_owner',
      setupToken,
      setupExpiresAt,
    };
  }

  public async reissueInvitation(input: {
    merchantId: string;
    operatorId: string;
    requestId?: string;
  }): Promise<ProvisionedMerchant> {
    if (!/^[0-9a-f]{32}$/u.test(input.merchantId)) {
      throw new MerchantInvitationNotReissuableError();
    }
    const operatorId = validOperator(input.operatorId);
    const merchantId = Buffer.from(input.merchantId, 'hex');
    const setupToken = randomBytes(32).toString('base64url');
    const tokenDigest = createHash('sha256').update(setupToken, 'ascii').digest();
    const setupExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const requestId = input.requestId ?? randomUUID();
    if (requestId.length === 0 || requestId.length > 128) {
      throw new Error('Request ID is invalid');
    }

    const connection = await this.#database.openConnection();
    let name: string;
    try {
      await connection.beginTransaction();
      try {
        const [rows] = await connection.execute<PendingMerchantRow[]>(
          `SELECT name, status FROM merchant WHERE id = ? LIMIT 1 FOR UPDATE`,
          [merchantId],
        );
        const merchant = rows[0];
        if (!merchant || merchant.status !== 'pending_owner') {
          throw new MerchantInvitationNotReissuableError();
        }
        name = merchant.name;
        await connection.execute(
          `UPDATE merchant_setup_invitation
              SET expires_at = UTC_TIMESTAMP(6)
            WHERE merchant_id = ? AND claimed_at IS NULL AND expires_at > UTC_TIMESTAMP(6)`,
          [merchantId],
        );
        await connection.execute(
          `INSERT INTO merchant_setup_invitation
             (token_digest, merchant_id, created_by_operator, expires_at, created_at)
           VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))`,
          [tokenDigest, merchantId, operatorId, setupExpiresAt],
        );
        await connection.execute(
          `INSERT INTO audit_log
             (id, merchant_id, actor_type, actor_id, action, target_type, target_id,
              result, request_id, occurred_at, created_at)
           VALUES (?, ?, 'platform_operator', ?, 'merchant.invitation.reissue', 'merchant', ?,
                   'success', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [randomBytes(16), merchantId, operatorId, input.merchantId, requestId],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      await connection.end();
    }

    return {
      id: input.merchantId,
      name: name!,
      status: 'pending_owner',
      setupToken,
      setupExpiresAt,
    };
  }

  async #insertProvisioningRecords(
    connection: Connection,
    input: {
      merchantId: Buffer;
      name: string;
      operatorId: string;
      requestId: string;
      setupExpiresAt: Date;
      tokenDigest: Buffer;
    },
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO merchant (id, name, status, timezone, created_at, updated_at)
       VALUES (?, ?, 'pending_owner', 'Asia/Shanghai', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [input.merchantId, input.name],
    );
    await connection.execute(
      `INSERT INTO merchant_setup_invitation
         (token_digest, merchant_id, created_by_operator, expires_at, created_at)
       VALUES (?, ?, ?, ?, UTC_TIMESTAMP(6))`,
      [input.tokenDigest, input.merchantId, input.operatorId, input.setupExpiresAt],
    );
    await connection.execute(
      `INSERT INTO audit_log
         (id, merchant_id, actor_type, actor_id, action, target_type, target_id,
          result, request_id, occurred_at, created_at)
       VALUES (?, ?, 'platform_operator', ?, 'merchant.provision', 'merchant', ?,
               'success', ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        randomBytes(16),
        input.merchantId,
        input.operatorId,
        input.merchantId.toString('hex'),
        input.requestId,
      ],
    );
  }
}
