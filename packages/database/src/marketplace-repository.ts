import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';
import {
  comparePassword,
  derivePassword,
  issueMerchantSession,
  passwordValue,
  phoneNumber,
  tokenDigest,
  type MerchantSessionIssued,
} from './merchant-access-repository.js';
import { emptyMarketplaceDraft, insertAssistantDraftRecords } from './assistant-draft-records.js';
import { marketplaceFixtureEnabled } from './marketplace-local-policy.js';
import { selfServicePolicy, type SelfServicePolicy } from './self-service-policy.js';

const product = 'h5ai-self-service-v1';
type Grant = RowDataPacket & {
  subject_digest: Buffer;
  status: string;
  valid_from: Date;
  expires_at: Date;
  source: string;
  code_expires: Date;
};
type Allocation = RowDataPacket & {
  merchant_user_id: Buffer;
  merchant_id: Buffer;
  assistant_id: Buffer;
};
type Credential = RowDataPacket & {
  merchant_user_id: Buffer;
  password_salt: Buffer;
  password_hash: Buffer;
  status: string;
};
export class MarketplaceAccessError extends Error {
  constructor(
    public readonly code:
      | 'not_eligible'
      | 'authentication_failed'
      | 'binding_conflict'
      | 'existing_resources_require_selection'
      | 'quota_exhausted'
      | 'state_unknown',
  ) {
    super(code);
    this.name = 'MarketplaceAccessError';
  }
}
/** Restricted local fixture adapter. It is deliberately not a production identity integration. */
export class MySqlMarketplaceRepository {
  readonly #phoneKey: Buffer | null;
  constructor(
    private readonly database: DatabaseConnectionConfig,
    phoneLookupKey?: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.#phoneKey = phoneLookupKey === undefined ? null : Buffer.from(phoneLookupKey, 'base64url');
    if (
      phoneLookupKey !== undefined &&
      (this.#phoneKey!.length < 32 || !/^[A-Za-z0-9_-]+$/u.test(phoneLookupKey))
    )
      throw new Error('Phone key required');
  }

  #assertFixture(): void {
    if (
      !marketplaceFixtureEnabled(this.environment) ||
      !['localhost', '127.0.0.1'].includes(this.database.summary.host) ||
      this.database.summary.database !== 'h5cs_marketplace_a6_test'
    )
      throw new MarketplaceAccessError('not_eligible');
  }

  /** Administrative test-only fixture; call only behind marketplaceFixtureEnabled(). No HTTP grant endpoint. */
  async createSyntheticGrant(input: { subject: string; modelCallLimit?: number }): Promise<string> {
    this.#assertFixture();
    if (!/^synthetic-[a-z0-9-]{1,80}$/u.test(input.subject))
      throw new Error('Synthetic subject required');
    const limit = input.modelCallLimit ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10)
      throw new Error('Local fixture limit must be 0–10');
    const subject = createHash('sha256')
      .update(`urn:h5cs:local-fixture\0h5cs-local\0${input.subject}`)
      .digest();
    const code = randomBytes(32).toString('base64url');
    const connection = await this.database.openConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT IGNORE INTO marketplace_free_claim (subject_digest, product, claim_id, source, price_version, created_at) VALUES (?, ?, ?, 'local-fixture', 'free-local-v1', UTC_TIMESTAMP(6))`,
        [subject, product, randomBytes(16)],
      );
      // Reissuing a code must never reset quota, extend expiry or revive revoked grants.
      await connection.execute(
        `INSERT IGNORE INTO marketplace_entitlement (subject_digest, product, status, version, valid_from, expires_at, model_call_limit, model_calls_reserved) VALUES (?, ?, 'active', 1, UTC_TIMESTAMP(6), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 1 DAY), ?, 0)`,
        [subject, product, limit],
      );
      await connection.execute(
        `INSERT INTO marketplace_claim_code (code_digest, subject_digest, product, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE))`,
        [tokenDigest(code), subject, product],
      );
      await connection.commit();
      return code;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      await connection.end();
    }
  }

  async claimSynthetic(input: {
    code: string;
    phone: string;
    password: string;
    reuseExisting?: boolean;
    requestId: string;
  }): Promise<MerchantSessionIssued & { assistantId: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#claimOnce(input);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
        if (
          attempt >= 2 ||
          !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'].includes(String(code))
        )
          throw error;
      }
    }
  }

  /** Native H5 free claim: identity is authenticated locally, offer comes only from server policy. */
  async claimFree(input: {
    merchantName: string;
    phone: string;
    password: string;
    reuseExisting?: boolean;
    requestId: string;
  }) {
    const policy = selfServicePolicy(this.environment);
    if (!policy || !this.#phoneKey) throw new MarketplaceAccessError('not_eligible');
    if (
      typeof input.merchantName !== 'string' ||
      !input.merchantName.trim() ||
      input.merchantName.trim().length > 100 ||
      /[\u0000-\u001f<>]/u.test(input.merchantName)
    )
      throw new MarketplaceAccessError('not_eligible');
    const digest = createHmac('sha256', this.#phoneKey).update(phoneNumber(input.phone)).digest();
    passwordValue(input.password);
    await this.#consumeSignupAttempt(digest);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#claimOnce({ ...input, code: '' }, policy);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
        if (
          attempt >= 2 ||
          !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_DUP_ENTRY'].includes(code)
        )
          throw error;
      }
    }
  }

  async #consumeSignupAttempt(phone: Buffer): Promise<void> {
    const connection = await this.database.openConnection();
    try {
      // Persistent limits count failed attempts too. No client-provided IP is trusted.
      for (const [key, limit] of [
        [createHash('sha256').update('public-free-global').digest(), 200],
        [phone, 6],
      ] as const) {
        await connection.execute(
          `INSERT INTO marketplace_signup_throttle (scope_digest, bucket, attempts)
          VALUES (?, FLOOR(UNIX_TIMESTAMP(UTC_TIMESTAMP()) / 600), 1)
          ON DUPLICATE KEY UPDATE attempts = IF(bucket = FLOOR(UNIX_TIMESTAMP(UTC_TIMESTAMP()) / 600), LEAST(attempts + 1, 100000), 1), bucket = FLOOR(UNIX_TIMESTAMP(UTC_TIMESTAMP()) / 600)`,
          [key],
        );
        const [rows] = await connection.execute<(RowDataPacket & { attempts: number })[]>(
          'SELECT attempts FROM marketplace_signup_throttle WHERE scope_digest = ?',
          [key],
        );
        if (!rows[0] || rows[0].attempts > limit) throw new MarketplaceAccessError('not_eligible');
      }
    } finally {
      await connection.end();
    }
  }

  async #freeGrant(
    connection: Connection,
    phone: Buffer,
    policy: SelfServicePolicy,
  ): Promise<Grant> {
    const subject = createHash('sha256').update('urn:h5cs:native-free:v1\0').update(phone).digest();
    await connection.execute(
      `INSERT INTO marketplace_campaign (campaign, claimed_count) VALUES (?, 0)
       ON DUPLICATE KEY UPDATE claimed_count = claimed_count`,
      [policy.campaign],
    );
    const [campaigns] = await connection.execute<(RowDataPacket & { claimed_count: number })[]>(
      'SELECT claimed_count FROM marketplace_campaign WHERE campaign = ? FOR UPDATE',
      [policy.campaign],
    );
    const [claim] = await connection.execute<ResultSetHeader>(
      `INSERT IGNORE INTO marketplace_free_claim (subject_digest, product, claim_id, source, price_version, created_at)
       VALUES (?, ?, ?, 'native-public-free', ?, UTC_TIMESTAMP(6))`,
      [subject, product, randomBytes(16), policy.campaign],
    );
    if (claim.affectedRows === 1) {
      if (!campaigns[0] || campaigns[0].claimed_count >= policy.maxClaims)
        throw new MarketplaceAccessError('not_eligible');
      await connection.execute(
        'UPDATE marketplace_campaign SET claimed_count = claimed_count + 1 WHERE campaign = ?',
        [policy.campaign],
      );
      await connection.execute(
        `INSERT INTO marketplace_entitlement (subject_digest, product, status, version, valid_from, expires_at, model_call_limit, model_calls_reserved)
        VALUES (?, ?, 'active', 1, UTC_TIMESTAMP(6), DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? DAY), ?, 0)`,
        [subject, product, policy.days, policy.modelCalls],
      );
    }
    const [grants] = await connection.execute<Grant[]>(
      `SELECT e.subject_digest, e.status, e.valid_from, e.expires_at, f.source
      FROM marketplace_entitlement e JOIN marketplace_free_claim f ON f.subject_digest=e.subject_digest AND f.product=e.product
      WHERE e.subject_digest=? AND e.product=? AND e.status='active' AND e.valid_from<=UTC_TIMESTAMP(6) AND e.expires_at>UTC_TIMESTAMP(6) FOR UPDATE`,
      [subject, product],
    );
    if (!grants[0] || grants[0].source !== 'native-public-free')
      throw new MarketplaceAccessError('not_eligible');
    return grants[0];
  }

  async #claimOnce(
    input: {
      merchantName?: string;
      code: string;
      phone: string;
      password: string;
      reuseExisting?: boolean;
      requestId: string;
    },
    policy?: SelfServicePolicy,
  ): Promise<MerchantSessionIssued & { assistantId: string }> {
    if (!policy) this.#assertFixture();
    if (!this.#phoneKey) throw new MarketplaceAccessError('not_eligible');
    if (
      (!policy && !/^[A-Za-z0-9_-]{43}$/u.test(input.code)) ||
      !/^[a-zA-Z0-9-]{1,64}$/u.test(input.requestId)
    )
      throw new MarketplaceAccessError('not_eligible');
    const phoneDigest = createHmac('sha256', this.#phoneKey)
      .update(phoneNumber(input.phone))
      .digest();
    const password = passwordValue(input.password);
    const connection = await this.database.openConnection();
    let committing = false;
    try {
      await connection.beginTransaction();
      const [grants] = policy
        ? [[await this.#freeGrant(connection, phoneDigest, policy)]]
        : await connection.execute<Grant[]>(
            `SELECT e.subject_digest, e.status, e.valid_from, e.expires_at, c.expires_at code_expires, f.source
         FROM marketplace_claim_code c JOIN marketplace_entitlement e ON e.subject_digest = c.subject_digest AND e.product = c.product
         JOIN marketplace_free_claim f ON f.subject_digest = e.subject_digest AND f.product = e.product
         WHERE c.code_digest = ? AND c.product = ? AND e.status = 'active' AND e.valid_from <= UTC_TIMESTAMP(6) AND e.expires_at > UTC_TIMESTAMP(6) AND c.expires_at > UTC_TIMESTAMP(6) FOR UPDATE`,
            [tokenDigest(input.code), product],
          );
      const grant = grants[0],
        now = new Date();
      if (
        !grant ||
        grant.source !== (policy ? 'native-public-free' : 'local-fixture') ||
        grant.status !== 'active'
      )
        throw new MarketplaceAccessError('not_eligible');
      const [credentials] = await connection.execute<Credential[]>(
        `SELECT c.merchant_user_id, c.password_salt, c.password_hash, u.status FROM merchant_password_credential c JOIN merchant_user u ON u.id = c.merchant_user_id WHERE c.phone_lookup_digest = ? FOR UPDATE`,
        [phoneDigest],
      );
      let user = credentials[0]?.merchant_user_id;
      if (
        credentials[0] &&
        (credentials[0].status !== 'active' || !(await comparePassword(password, credentials[0])))
      )
        throw new MarketplaceAccessError('authentication_failed');
      const [allocations] = await connection.execute<Allocation[]>(
        `SELECT merchant_user_id, merchant_id, assistant_id FROM marketplace_allocation WHERE subject_digest = ? AND product = ? FOR UPDATE`,
        [grant.subject_digest, product],
      );
      let allocation = allocations[0];
      // A known subject is never rebound based on a caller-supplied phone number.
      if (allocation && (!user || !allocation.merchant_user_id.equals(user)))
        throw new MarketplaceAccessError('binding_conflict');
      if (!user) {
        user = randomBytes(16);
        const salt = randomBytes(16),
          hash = await derivePassword(password, salt, 64);
        await connection.execute(
          `INSERT INTO merchant_user (id, status, created_at, updated_at) VALUES (?, 'active', ?, ?)`,
          [user, now, now],
        );
        await connection.execute(
          `INSERT INTO merchant_password_credential (merchant_user_id, phone_lookup_digest, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [user, phoneDigest, salt, hash, now, now],
        );
      }
      if (!allocation) {
        const [accountAllocations] = await connection.execute<RowDataPacket[]>(
          `SELECT merchant_id FROM marketplace_allocation WHERE merchant_user_id = ? AND product = ? FOR UPDATE`,
          [user, product],
        );
        if (accountAllocations.length) throw new MarketplaceAccessError('binding_conflict');
        const [memberships] = await connection.execute<
          (RowDataPacket & {
            merchant_id: Buffer;
            role: string;
            status: string;
            merchant_status: string;
          })[]
        >(
          `SELECT mm.merchant_id, mm.role, mm.status, m.status merchant_status FROM merchant_membership mm JOIN merchant m ON m.id = mm.merchant_id WHERE mm.merchant_user_id = ? ORDER BY mm.merchant_id`,
          [user],
        );
        let merchant: Buffer = randomBytes(16),
          assistant: Buffer | undefined;
        if (memberships.length) {
          const member = memberships[0]!;
          if (
            !input.reuseExisting ||
            memberships.length !== 1 ||
            member.role !== 'owner' ||
            member.status !== 'active' ||
            member.merchant_status !== 'active'
          )
            throw new MarketplaceAccessError('existing_resources_require_selection');
          merchant = member.merchant_id;
          const [currentMembership] = await connection.execute<RowDataPacket[]>(
            `SELECT id FROM merchant WHERE id = ? AND status='active' FOR UPDATE`,
            [merchant],
          );
          if (currentMembership.length !== 1) throw new MarketplaceAccessError('not_eligible');
          const [members] = await connection.execute<RowDataPacket[]>(
            `SELECT merchant_id FROM merchant_membership WHERE merchant_id=? AND merchant_user_id=? AND role='owner' AND status='active' FOR UPDATE`,
            [merchant, user],
          );
          if (members.length !== 1) throw new MarketplaceAccessError('not_eligible');
          const [assistants] = await connection.execute<(RowDataPacket & { id: Buffer })[]>(
            `SELECT a.id FROM merchant_assistant ma JOIN assistant a ON a.merchant_id=ma.merchant_id AND a.id=ma.assistant_id WHERE ma.merchant_id = ? FOR UPDATE`,
            [merchant],
          );
          if (assistants.length > 1)
            throw new MarketplaceAccessError('existing_resources_require_selection');
          assistant = assistants[0]?.id;
          if (!assistant) {
            const [historical] = await connection.execute<RowDataPacket[]>(
              'SELECT id FROM assistant WHERE merchant_id=? LIMIT 1 FOR UPDATE',
              [merchant],
            );
            if (historical.length) throw new MarketplaceAccessError('binding_conflict');
          }
        } else {
          await connection.execute(
            `INSERT INTO merchant (id, name, status, timezone, created_at, updated_at) VALUES (?, ?, 'active', 'Asia/Shanghai', ?, ?)`,
            [merchant, input.merchantName?.trim() ?? '待完善商家资料', now, now],
          );
          await connection.execute(
            `INSERT INTO merchant_membership (merchant_id, merchant_user_id, role, status, created_at, updated_at) VALUES (?, ?, 'owner', 'active', ?, ?)`,
            [merchant, user, now, now],
          );
        }
        if (!assistant) {
          assistant = randomBytes(16);
          await insertAssistantDraftRecords(connection, {
            assistantId: assistant,
            merchantId: merchant,
            merchantUserId: user,
            displayName: '待完善 AI 客服',
            slug: `a-${randomBytes(18).toString('hex')}`,
            draft: emptyMarketplaceDraft,
            now,
          });
          await connection.execute(
            'INSERT INTO merchant_assistant (merchant_id, assistant_id, created_at) VALUES (?, ?, ?)',
            [merchant, assistant, now],
          );
        }
        await connection.execute(
          `INSERT INTO marketplace_allocation (subject_digest, product, merchant_user_id, merchant_id, assistant_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [grant.subject_digest, product, user, merchant, assistant, now],
        );
        allocation = {
          merchant_user_id: user,
          merchant_id: merchant,
          assistant_id: assistant,
        } as Allocation;
        await connection.execute(
          `INSERT INTO audit_log (id, merchant_id, actor_type, actor_id, action, target_type, target_id, result, request_id, occurred_at, created_at) VALUES (?, ?, 'system', ?, 'marketplace.allocate', 'assistant', ?, 'success', ?, ?, ?)`,
          [
            randomBytes(16),
            merchant,
            policy ? 'native-public-free' : 'marketplace-local-fixture',
            assistant.toString('hex'),
            input.requestId,
            now,
            now,
          ],
        );
        await connection.execute(
          `INSERT INTO outbox_event (id, merchant_id, event_type, aggregate_type, aggregate_id, schema_version, payload, state, attempt, available_at, occurred_at, created_at) VALUES (?, ?, 'marketplace.allocated', 'assistant', ?, 1, ?, 'pending', 0, ?, ?, ?)`,
          [
            randomBytes(16),
            merchant,
            assistant,
            JSON.stringify({ product, fixture: !policy }),
            now,
            now,
            now,
          ],
        );
      }
      const [authorized] = await connection.execute<RowDataPacket[]>(
        `SELECT mm.merchant_id FROM merchant_membership mm JOIN merchant m ON m.id = mm.merchant_id JOIN merchant_user u ON u.id = mm.merchant_user_id WHERE mm.merchant_user_id = ? AND mm.merchant_id = ? AND mm.role = 'owner' AND mm.status = 'active' AND m.status = 'active' AND u.status = 'active' FOR UPDATE`,
        [user, allocation.merchant_id],
      );
      if (authorized.length !== 1) throw new MarketplaceAccessError('not_eligible');
      const session = await issueMerchantSession(connection, user, allocation.merchant_id);
      committing = true;
      await connection.commit();
      return { ...session, assistantId: allocation.assistant_id.toString('hex') };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      // Never blindly repeat a possibly committed operation. Same subject/account retry reads allocation.
      if (committing) throw new MarketplaceAccessError('state_unknown');
      throw error;
    } finally {
      await connection.end().catch(() => undefined);
    }
  }

  /** Reserve every actual supplier attempt, including failed/unknown calls and Job retries. */
  async quotaForMerchant(merchantId: string): Promise<{
    limit: number;
    reserved: number;
    expiresAt: Date;
    state: 'active' | 'paused' | 'revoked' | 'expired' | 'not_started';
  } | null> {
    if (!/^[0-9a-f]{32}$/u.test(merchantId)) throw new MarketplaceAccessError('not_eligible');
    const connection = await this.database.openConnection();
    try {
      const [rows] = await connection.execute<
        (RowDataPacket & {
          model_call_limit: number;
          model_calls_reserved: number;
          expires_at: Date;
          valid_from: Date;
          status: string;
          effective_state: 'active' | 'paused' | 'revoked' | 'expired' | 'not_started';
        })[]
      >(
        `SELECT CASE WHEN e.status <> 'active' THEN IF(e.status='paused','paused','revoked') WHEN e.valid_from > UTC_TIMESTAMP(6) THEN 'not_started' WHEN e.expires_at <= UTC_TIMESTAMP(6) THEN 'expired' ELSE 'active' END effective_state, e.status, e.valid_from, e.model_call_limit, e.model_calls_reserved, e.expires_at FROM marketplace_allocation a JOIN marketplace_entitlement e ON e.subject_digest = a.subject_digest AND e.product = a.product WHERE a.merchant_id = ? AND a.product = ?`,
        [Buffer.from(merchantId, 'hex'), product],
      );
      const row = rows[0];
      return row
        ? {
            state: row.effective_state,
            limit: row.model_call_limit,
            reserved: row.model_calls_reserved,
            expiresAt: row.expires_at,
          }
        : null;
    } finally {
      await connection.end();
    }
  }

  async assertModelAccess(merchantId: string): Promise<void> {
    const quota = await this.quotaForMerchant(merchantId);
    if (quota && quota.state !== 'active') throw new MarketplaceAccessError('not_eligible');
  }

  /** This counter is a conservative supplier-attempt budget, not a business-success report. */
  async reserveModelCall(merchantId: string, operation: string): Promise<void> {
    if (
      !/^[0-9a-f]{32}$/u.test(merchantId) ||
      !['consumer', 'preview', 'writing', 'organize'].includes(operation)
    )
      throw new MarketplaceAccessError('not_eligible');
    const connection = await this.database.openConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<
        (RowDataPacket & {
          is_eligible: number;
          subject_digest: Buffer;
          status: string;
          valid_from: Date;
          expires_at: Date;
          model_call_limit: number;
          model_calls_reserved: number;
        })[]
      >(
        `SELECT (e.status = 'active' AND e.valid_from <= UTC_TIMESTAMP(6) AND e.expires_at > UTC_TIMESTAMP(6)) is_eligible, e.subject_digest, e.status, e.valid_from, e.expires_at, e.model_call_limit, e.model_calls_reserved FROM marketplace_allocation a JOIN marketplace_entitlement e ON e.subject_digest = a.subject_digest AND e.product = a.product WHERE a.merchant_id = ? AND a.product = ? FOR UPDATE`,
        [Buffer.from(merchantId, 'hex'), product],
      );
      const row = rows[0];
      // Merchants outside this self-service product keep their existing model policy.
      if (row) {
        if (row.is_eligible !== 1) throw new MarketplaceAccessError('not_eligible');
        if (row.model_calls_reserved >= row.model_call_limit)
          throw new MarketplaceAccessError('quota_exhausted');
        await connection.execute(
          `UPDATE marketplace_entitlement SET model_calls_reserved = model_calls_reserved + 1 WHERE subject_digest = ? AND product = ?`,
          [row.subject_digest, product],
        );
        await connection.execute(
          `INSERT INTO marketplace_model_attempt (id, subject_digest, product, operation, state, created_at) VALUES (?, ?, ?, ?, 'reserved_may_charge', UTC_TIMESTAMP(6))`,
          [randomBytes(16), row.subject_digest, product, operation],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      await connection.end().catch(() => undefined);
    }
  }
}
