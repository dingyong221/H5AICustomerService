import { randomBytes } from 'node:crypto';

import type {
  AssistantId,
  MerchantId,
  MerchantUserId,
  OnboardingRepository,
  OnboardingSessionId,
  OnboardingSessionRecord,
  OnboardingSnapshot,
  VerifiedExternalIdentity,
} from '@h5cs/domain';
import {
  ExternalIdentityBindingConflictError,
  getOnboardingMissingItems,
  MerchantSelectionRequiredError,
  onboardingStates,
  toAssistantId,
  toMerchantId,
  toMerchantUserId,
  toOnboardingSessionId,
} from '@h5cs/domain';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';
import { probeDatabase } from './config.js';

type ExternalIdentityRow = RowDataPacket & {
  merchant_user_id: Buffer;
  status: string;
};

type MerchantBindingRow = RowDataPacket & {
  merchant_id: Buffer;
};

type OnboardingRow = RowDataPacket & {
  id: Buffer;
  merchant_user_id: Buffer;
  merchant_id: Buffer | null;
  assistant_id: Buffer | null;
  state: string;
  cancelled_from_state: string | null;
  answers: string | Record<string, unknown>;
  generation_error_code: string | null;
  version: number;
};

const newId = (): Buffer => randomBytes(16);
const idToString = (value: Buffer): string => {
  if (value.byteLength !== 16) {
    throw new OnboardingPersistenceError('Stored binary ID must contain exactly 16 bytes');
  }
  return value.toString('hex');
};

export const binaryIdFromString = (value: string): Buffer => {
  if (!/^[0-9a-f]{32}$/iu.test(value)) {
    throw new OnboardingPersistenceError(
      'Binary ID input must contain exactly 32 hexadecimal characters',
    );
  }
  return Buffer.from(value, 'hex');
};

const stringToId = binaryIdFromString;

const parseJsonObject = (value: string | Record<string, unknown>): Record<string, unknown> => {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new OnboardingPersistenceError('Stored onboarding answers are invalid');
    }
    return parsed as Record<string, unknown>;
  }
  return value;
};

const parseSnapshot = (row: OnboardingRow): OnboardingSnapshot => {
  if (!onboardingStates.some((state) => state === row.state)) {
    throw new OnboardingPersistenceError('Stored onboarding state is invalid');
  }

  const state = row.state as OnboardingSnapshot['state'];
  const cancelledFrom =
    row.cancelled_from_state === null
      ? undefined
      : onboardingStates.find(
          (candidate) =>
            candidate === row.cancelled_from_state &&
            candidate !== 'cancelled' &&
            candidate !== 'manageable',
        );

  if (row.cancelled_from_state !== null && cancelledFrom === undefined) {
    throw new OnboardingPersistenceError('Stored onboarding resume state is invalid');
  }

  return {
    state,
    answers: parseJsonObject(row.answers),
    ...(cancelledFrom === undefined ? {} : { cancelledFrom }),
    ...(row.generation_error_code === null
      ? {}
      : { generationErrorCode: row.generation_error_code }),
  } as OnboardingSnapshot;
};

const rowToSession = (row: OnboardingRow): OnboardingSessionRecord => ({
  id: toOnboardingSessionId(idToString(row.id)),
  merchantUserId: toMerchantUserId(idToString(row.merchant_user_id)),
  merchantId: row.merchant_id === null ? null : toMerchantId(idToString(row.merchant_id)),
  assistantId: row.assistant_id === null ? null : toAssistantId(idToString(row.assistant_id)),
  snapshot: parseSnapshot(row),
  version: row.version,
});

export class OnboardingPersistenceError extends Error {
  public constructor(message = 'Onboarding persistence is unavailable') {
    super(message);
    this.name = 'OnboardingPersistenceError';
  }
}

export class OnboardingOptimisticLockError extends Error {
  public constructor() {
    super('Onboarding session was updated by another request');
    this.name = 'OnboardingOptimisticLockError';
  }
}

export class UnavailableOnboardingRepository implements OnboardingRepository {
  readonly #reason: string;

  public constructor(reason: string) {
    this.#reason = reason;
  }

  public async assertReady(): Promise<void> {
    await Promise.resolve();
    throw new OnboardingPersistenceError(this.#reason);
  }

  public async resolveOrCreateMerchantUser(): Promise<never> {
    return this.#fail();
  }

  public async findMerchantBinding(): Promise<never> {
    return this.#fail();
  }

  public async listAssistants(): Promise<never> {
    return this.#fail();
  }

  public async findLatestSession(): Promise<never> {
    return this.#fail();
  }

  public async findSession(): Promise<never> {
    return this.#fail();
  }

  public async createSession(): Promise<never> {
    return this.#fail();
  }

  public async saveSession(): Promise<never> {
    return this.#fail();
  }

  public async saveGenerationResult(): Promise<never> {
    return this.#fail();
  }

  async #fail(): Promise<never> {
    await Promise.resolve();
    throw new OnboardingPersistenceError(this.#reason);
  }
}

export class MySqlOnboardingRepository implements OnboardingRepository {
  readonly #config: DatabaseConnectionConfig;

  public constructor(config: DatabaseConnectionConfig) {
    this.#config = config;
  }

  public async assertReady(): Promise<void> {
    const probe = await probeDatabase(this.#config);
    if (!probe.ok) throw new OnboardingPersistenceError();
  }

  public async resolveOrCreateMerchantUser(
    identity: VerifiedExternalIdentity,
  ): Promise<{ id: MerchantUserId }> {
    return this.#withConnection(async (connection) => {
      const existing = await this.#findExternalIdentity(connection, identity);
      if (existing !== null) {
        if (existing.status !== 'active') {
          throw new ExternalIdentityBindingConflictError();
        }
        await connection.execute(
          `UPDATE external_identity
             SET last_seen_at = ?,
                 phone_match_verified_at = COALESCE(?, phone_match_verified_at),
                 subject_lookup_key_version = ?,
                 updated_at = UTC_TIMESTAMP(6)
           WHERE provider = ? AND issuer = ? AND audience = ? AND subject_lookup_key = ?
             AND status = 'active'`,
          [
            identity.verifiedAt,
            identity.phoneMatchVerifiedAt,
            identity.subjectLookupKeyVersion,
            identity.provider,
            identity.issuer,
            identity.audience,
            Buffer.from(identity.subjectLookupKey),
          ],
        );
        return { id: toMerchantUserId(idToString(existing.merchant_user_id)) };
      }

      const merchantUserId = newId();
      const externalIdentityId = newId();
      await connection.beginTransaction();
      try {
        await connection.execute(
          `INSERT INTO merchant_user (id, status, created_at, updated_at)
           VALUES (?, 'active', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [merchantUserId],
        );
        await connection.execute(
          `INSERT INTO external_identity
             (id, merchant_user_id, provider, issuer, audience, subject_lookup_key,
              subject_lookup_key_version,
              phone_match_verified_at,
              last_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [
            externalIdentityId,
            merchantUserId,
            identity.provider,
            identity.issuer,
            identity.audience,
            Buffer.from(identity.subjectLookupKey),
            identity.subjectLookupKeyVersion,
            identity.phoneMatchVerifiedAt,
            identity.verifiedAt,
          ],
        );
        await connection.commit();
        return { id: toMerchantUserId(idToString(merchantUserId)) };
      } catch (error) {
        await connection.rollback();
        const raced = await this.#findExternalIdentity(connection, identity);
        if (raced !== null) {
          if (raced.status !== 'active') {
            throw new ExternalIdentityBindingConflictError();
          }
          return { id: toMerchantUserId(idToString(raced.merchant_user_id)) };
        }
        throw error;
      }
    });
  }

  public async findMerchantBinding(merchantUserId: MerchantUserId): Promise<MerchantId | null> {
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<MerchantBindingRow[]>(
        `SELECT mm.merchant_id
           FROM merchant_membership mm
           JOIN merchant m ON m.id = mm.merchant_id
           JOIN merchant_user u ON u.id = mm.merchant_user_id
          WHERE mm.merchant_user_id = ? AND mm.status = 'active'
            AND m.status = 'active' AND u.status = 'active'
          ORDER BY mm.created_at ASC, mm.merchant_id ASC
          LIMIT 2`,
        [stringToId(merchantUserId)],
      );
      if (rows.length > 1) throw new MerchantSelectionRequiredError();
      const row = rows[0];
      return row === undefined ? null : toMerchantId(idToString(row.merchant_id));
    });
  }

  public async listAssistants(
    merchantId: MerchantId,
    merchantUserId: MerchantUserId,
  ): Promise<readonly { id: AssistantId; status: string }[]> {
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<(RowDataPacket & { id: Buffer; status: string })[]>(
        `SELECT a.id, a.status
           FROM assistant a
           JOIN merchant m ON m.id = a.merchant_id
           JOIN merchant_membership mm ON mm.merchant_id = m.id
           JOIN merchant_user u ON u.id = mm.merchant_user_id
          WHERE a.merchant_id = ? AND mm.merchant_user_id = ?
            AND a.status <> 'archived' AND m.status = 'active'
            AND mm.status = 'active' AND u.status = 'active'
          ORDER BY a.created_at ASC, a.id ASC`,
        [stringToId(merchantId), stringToId(merchantUserId)],
      );
      return rows.map((row) => ({ id: toAssistantId(idToString(row.id)), status: row.status }));
    });
  }

  public async findLatestSession(
    merchantUserId: MerchantUserId,
  ): Promise<OnboardingSessionRecord | null> {
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<OnboardingRow[]>(
        `SELECT id, merchant_user_id, merchant_id, assistant_id, state, cancelled_from_state,
                answers, generation_error_code, version
           FROM onboarding_session
          WHERE merchant_user_id = ?
          ORDER BY updated_at DESC, id DESC
          LIMIT 1`,
        [stringToId(merchantUserId)],
      );
      return rows[0] === undefined ? null : rowToSession(rows[0]);
    });
  }

  public async findSession(
    merchantUserId: MerchantUserId,
    sessionId: OnboardingSessionId,
  ): Promise<OnboardingSessionRecord | null> {
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<OnboardingRow[]>(
        `SELECT id, merchant_user_id, merchant_id, assistant_id, state, cancelled_from_state,
                answers, generation_error_code, version
           FROM onboarding_session
          WHERE id = ? AND merchant_user_id = ?
          LIMIT 1`,
        [stringToId(sessionId), stringToId(merchantUserId)],
      );
      return rows[0] === undefined ? null : rowToSession(rows[0]);
    });
  }

  public async createSession(
    merchantUserId: MerchantUserId,
    snapshot: OnboardingSnapshot,
  ): Promise<OnboardingSessionRecord> {
    const sessionId = newId();
    const missingItems = getOnboardingMissingItems(snapshot);
    await this.#withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO onboarding_session
           (id, merchant_user_id, state, answers, missing_items, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
        [
          sessionId,
          stringToId(merchantUserId),
          snapshot.state,
          JSON.stringify(snapshot.answers),
          JSON.stringify(missingItems),
        ],
      );
    });

    return {
      id: toOnboardingSessionId(idToString(sessionId)),
      merchantUserId,
      merchantId: null,
      assistantId: null,
      snapshot,
      version: 1,
    };
  }

  public async saveSession(
    session: OnboardingSessionRecord,
    nextSnapshot: OnboardingSnapshot,
  ): Promise<OnboardingSessionRecord> {
    if (nextSnapshot.state === 'manageable') {
      throw new OnboardingPersistenceError(
        'Generation completion must persist merchant and assistant ownership atomically',
      );
    }
    const missingItems = getOnboardingMissingItems(nextSnapshot);
    const result = await this.#withConnection(async (connection) => {
      const [header] = await connection.execute<ResultSetHeader>(
        `UPDATE onboarding_session
            SET state = ?, cancelled_from_state = ?, answers = ?, missing_items = ?,
                generation_error_code = ?, version = version + 1,
                cancelled_at = CASE WHEN ? = 'cancelled' THEN UTC_TIMESTAMP(6) ELSE NULL END,
                completed_at = CASE WHEN ? = 'manageable' THEN UTC_TIMESTAMP(6) ELSE completed_at END,
                updated_at = UTC_TIMESTAMP(6)
          WHERE id = ? AND merchant_user_id = ? AND version = ?`,
        [
          nextSnapshot.state,
          nextSnapshot.cancelledFrom ?? null,
          JSON.stringify(nextSnapshot.answers),
          JSON.stringify(missingItems),
          nextSnapshot.generationErrorCode ?? null,
          nextSnapshot.state,
          nextSnapshot.state,
          stringToId(session.id),
          stringToId(session.merchantUserId),
          session.version,
        ],
      );
      return header;
    });

    if (result.affectedRows !== 1) throw new OnboardingOptimisticLockError();
    return { ...session, snapshot: nextSnapshot, version: session.version + 1 };
  }

  public async saveGenerationResult(
    _session: OnboardingSessionRecord,
    _nextSnapshot: OnboardingSnapshot,
    _merchantId: MerchantId,
    _assistantId: AssistantId,
  ): Promise<never> {
    await Promise.resolve();
    throw new OnboardingPersistenceError(
      'Generation completion requires the idempotent assistant lifecycle transaction',
    );
  }

  async #findExternalIdentity(
    connection: Connection,
    identity: VerifiedExternalIdentity,
  ): Promise<ExternalIdentityRow | null> {
    const [rows] = await connection.execute<ExternalIdentityRow[]>(
      `SELECT merchant_user_id, status
         FROM external_identity
        WHERE provider = ? AND issuer = ? AND audience = ? AND subject_lookup_key = ?
        LIMIT 1`,
      [
        identity.provider,
        identity.issuer,
        identity.audience,
        Buffer.from(identity.subjectLookupKey),
      ],
    );
    return rows[0] ?? null;
  }

  async #withConnection<TResult>(
    operation: (connection: Connection) => Promise<TResult>,
  ): Promise<TResult> {
    const connection = await this.#config.openConnection();
    try {
      return await operation(connection);
    } finally {
      await connection.end();
    }
  }
}
