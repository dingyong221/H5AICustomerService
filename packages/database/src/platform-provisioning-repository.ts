import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

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

export class MerchantProvisionAlreadyAppliedError extends Error {
  public constructor(public readonly merchantId: string) {
    super('Merchant provisioning request was already applied');
    this.name = 'MerchantProvisionAlreadyAppliedError';
  }
}

export class MerchantProvisionIdempotencyConflictError extends Error {
  public constructor() {
    super('Merchant provisioning request key was reused with different input');
    this.name = 'MerchantProvisionIdempotencyConflictError';
  }
}

export type PlatformMerchantSummary = Readonly<{
  id: string;
  name: string;
  status: string;
  createdAt: Date;
}>;

export type PlatformAuditSummary = Readonly<{
  id: string;
  operatorId: string;
  action: string;
  merchantId: string | null;
  result: string;
  occurredAt: Date;
}>;

export type PlatformAssistantSummary = Readonly<{
  id: string;
  merchantId: string;
  merchantName: string;
  displayName: string;
  status: string;
  activeReleaseId: string | null;
  updatedAt: Date;
}>;

export type PlatformJobSummary = Readonly<{
  id: string;
  merchantId: string | null;
  type: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  updatedAt: Date;
}>;

export type PlatformJobOverview = Readonly<{
  pending: number;
  processing: number;
  failed: number;
  recentFailed: readonly PlatformJobSummary[];
}>;

type MerchantRow = RowDataPacket & {
  id: Buffer;
  name: string;
  status: string;
  created_at: Date;
};

type PendingMerchantRow = RowDataPacket & { name: string; status: string };
type PlatformAuditRow = RowDataPacket & {
  id: Buffer;
  actor_id: string;
  action: string;
  merchant_id: Buffer | null;
  result: string;
  occurred_at: Date;
};
type ProvisionIdempotencyRow = RowDataPacket & {
  request_hash: Buffer;
  state: string;
  resource_id: Buffer | null;
};
type PlatformAssistantRow = RowDataPacket & {
  id: Buffer;
  merchant_id: Buffer;
  merchant_name: string;
  display_name: string;
  status: string;
  active_release_id: Buffer | null;
  updated_at: Date;
};
type JobCountRow = RowDataPacket & { state: string; total: number | string };
type PlatformJobRow = RowDataPacket & {
  id: Buffer;
  merchant_id: Buffer | null;
  type: string;
  state: string;
  attempt: number;
  max_attempts: number;
  last_error_code: string | null;
  updated_at: Date;
};

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY';

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

  public async listPlatformAudits(limit = 20): Promise<readonly PlatformAuditSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Audit list limit is invalid');
    }
    const connection = await this.#database.openConnection();
    try {
      const [rows] = await connection.execute<PlatformAuditRow[]>(
        `SELECT id, actor_id, action, merchant_id, result, occurred_at
           FROM audit_log
          WHERE actor_type = 'platform_operator'
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?`,
        [limit],
      );
      return rows.map((row) => ({
        id: row.id.toString('hex'),
        operatorId: row.actor_id,
        action: row.action,
        merchantId: row.merchant_id?.toString('hex') ?? null,
        result: row.result,
        occurredAt: row.occurred_at,
      }));
    } finally {
      await connection.end();
    }
  }

  public async listAssistantStates(limit = 50): Promise<readonly PlatformAssistantSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Assistant list limit is invalid');
    }
    const connection = await this.#database.openConnection();
    try {
      const [rows] = await connection.execute<PlatformAssistantRow[]>(
        `SELECT a.id, a.merchant_id, m.name AS merchant_name, a.display_name,
                a.status, a.active_release_id, a.updated_at
           FROM assistant a
           JOIN merchant m ON m.id = a.merchant_id
          ORDER BY a.updated_at DESC, a.id DESC
          LIMIT ?`,
        [limit],
      );
      return rows.map((row) => ({
        id: row.id.toString('hex'),
        merchantId: row.merchant_id.toString('hex'),
        merchantName: row.merchant_name,
        displayName: row.display_name,
        status: row.status,
        activeReleaseId: row.active_release_id?.toString('hex') ?? null,
        updatedAt: row.updated_at,
      }));
    } finally {
      await connection.end();
    }
  }

  public async jobOverview(limit = 20): Promise<PlatformJobOverview> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error('Job list limit is invalid');
    }
    const connection = await this.#database.openConnection();
    try {
      const [counts] = await connection.execute<JobCountRow[]>(
        `SELECT state, COUNT(*) AS total
           FROM job
          WHERE state IN ('pending', 'processing', 'failed')
          GROUP BY state`,
      );
      const totals = { pending: 0, processing: 0, failed: 0 };
      for (const row of counts) {
        if (row.state !== 'pending' && row.state !== 'processing' && row.state !== 'failed') {
          throw new Error('Unexpected job state');
        }
        const total = Number(row.total);
        if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid job count');
        totals[row.state] = total;
      }
      const [rows] = await connection.execute<PlatformJobRow[]>(
        `SELECT id, merchant_id, type, state, attempt, max_attempts,
                last_error_code, updated_at
           FROM job
          WHERE state = 'failed'
          ORDER BY updated_at DESC, id DESC
          LIMIT ?`,
        [limit],
      );
      return {
        ...totals,
        recentFailed: rows.map((row) => ({
          id: row.id.toString('hex'),
          merchantId: row.merchant_id?.toString('hex') ?? null,
          type: row.type,
          state: row.state,
          attempt: row.attempt,
          maxAttempts: row.max_attempts,
          lastErrorCode: row.last_error_code,
          updatedAt: row.updated_at,
        })),
      };
    } finally {
      await connection.end();
    }
  }

  public async provisionMerchant(input: {
    name: string;
    operatorId: string;
    idempotencyKey?: string;
    requestId?: string;
  }): Promise<ProvisionedMerchant> {
    const name = validName(input.name);
    const operatorId = validOperator(input.operatorId);
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(idempotencyKey)) {
      throw new Error('Merchant provisioning idempotency key is invalid');
    }
    const actorScopeDigest = createHash('sha256')
      .update(`platform_operator\0${operatorId}`, 'utf8')
      .digest();
    const keyDigest = createHash('sha256').update(idempotencyKey, 'ascii').digest();
    const requestHash = createHash('sha256').update(name, 'utf8').digest();
    const merchantId = randomBytes(16);
    const idempotencyId = randomBytes(16);
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
        await connection.execute(
          `INSERT INTO idempotency_record
             (id, merchant_id, actor_scope_digest, operation, key_digest, request_hash,
              state, expires_at, created_at, updated_at)
           VALUES (?, NULL, ?, 'merchant.provision', ?, ?, 'processing', ?,
                   UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [
            idempotencyId,
            actorScopeDigest,
            keyDigest,
            requestHash,
            new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
          ],
        );
        await this.#insertProvisioningRecords(connection, {
          merchantId,
          name,
          operatorId,
          requestId,
          setupExpiresAt,
          tokenDigest,
        });
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE idempotency_record
              SET merchant_id = ?, state = 'succeeded', resource_type = 'merchant',
                  resource_id = ?, response_code = 201, updated_at = UTC_TIMESTAMP(6)
            WHERE id = ? AND state = 'processing'`,
          [merchantId, merchantId, idempotencyId],
        );
        if (updated.affectedRows !== 1) throw new Error('Merchant provisioning state is invalid');
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      await this.#recoverProvision(actorScopeDigest, keyDigest, requestHash, error);
      throw error;
    } finally {
      await connection.end().catch(() => undefined);
    }

    return {
      id: merchantId.toString('hex'),
      name,
      status: 'pending_owner',
      setupToken,
      setupExpiresAt,
    };
  }

  async #recoverProvision(
    actorScopeDigest: Buffer,
    keyDigest: Buffer,
    requestHash: Buffer,
    originalError: unknown,
  ): Promise<never> {
    const connection = await this.#database.openConnection();
    try {
      const [rows] = await connection.execute<ProvisionIdempotencyRow[]>(
        `SELECT request_hash, state, resource_id
           FROM idempotency_record
          WHERE actor_scope_digest = ? AND operation = 'merchant.provision' AND key_digest = ?
          LIMIT 1`,
        [actorScopeDigest, keyDigest],
      );
      const record = rows[0];
      if (!record) throw originalError;
      if (!record.request_hash.equals(requestHash)) {
        throw new MerchantProvisionIdempotencyConflictError();
      }
      if (record.state !== 'succeeded' || !record.resource_id) throw originalError;
      throw new MerchantProvisionAlreadyAppliedError(record.resource_id.toString('hex'));
    } finally {
      await connection.end().catch(() => undefined);
    }
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
      await connection.end().catch(() => undefined);
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
