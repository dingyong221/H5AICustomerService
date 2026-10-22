import { createHash, randomBytes } from 'node:crypto';

import type {
  AssistantDraftConfig,
  AssistantId,
  AssistantLifecycleIdempotency,
  AssistantLifecycleRepository,
  AssistantManagementSnapshot,
  AssistantReleaseRecord,
  MerchantId,
  MerchantUserId,
  OnboardingSessionId,
  PublicAssistantSnapshot,
  ReleaseId,
} from '@h5cs/domain';
import {
  AssistantGenerationUnavailableError,
  AssistantIdempotencyConflictError,
  AssistantLifecyclePersistenceError,
  AssistantPublishValidationError,
  AssistantRevisionConflictError,
  normalizeHumanContact,
  toAssistantId,
  toMerchantId,
  toReleaseId,
} from '@h5cs/domain';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';
import { probeDatabase } from './config.js';
import { bindVerifiedImprovementsToRelease } from './assistant-improvement-release.js';

type OnboardingGenerationRow = RowDataPacket & {
  answers: string | Record<string, unknown>;
  missing_items: string | readonly unknown[];
  version: number;
};

type ManagementRow = RowDataPacket & {
  assistant_id: Buffer;
  merchant_id: Buffer;
  display_name: string;
  public_slug: string;
  status: string;
  draft_revision: number;
  config: string | Record<string, unknown>;
  validation: string | Record<string, unknown>;
  active_release_id: Buffer | null;
  created_at: Date;
  updated_at: Date;
};

type PublishRow = ManagementRow & {
  membership_status: string;
  merchant_status: string;
};

type IdempotencyRow = RowDataPacket & {
  request_hash: Buffer;
  state: string;
  resource_id: Buffer | null;
  response_body: string | Record<string, unknown> | null;
};

type ReleaseRow = RowDataPacket & {
  release_id: Buffer;
  merchant_id: Buffer;
  assistant_id: Buffer;
  release_no: number;
  draft_revision: number;
  created_at: Date;
  activated_at: Date;
};

type PublicRow = RowDataPacket & {
  public_slug: string;
  release_id: Buffer;
  merchant_name: string;
  display_name: string;
  config_snapshot: string | Record<string, unknown>;
};

type HistoryRow = ReleaseRow & {
  status: string;
  active_release_id: Buffer | null;
  membership_role: string;
  config_snapshot: string | Record<string, unknown>;
};

export type AssistantReleaseHistoryItem = Readonly<{
  releaseId: ReleaseId;
  releaseNo: number;
  draftRevision: number;
  status: 'active' | 'retired';
  createdAt: Date;
  activatedAt: Date;
  isCurrent: boolean;
  canRestore: boolean;
}>;

export type AssistantReleaseHistorySnapshot = AssistantReleaseHistoryItem &
  Readonly<{ draft: AssistantDraftConfig }>;

export class AssistantHistorySourceUnavailableError extends Error {
  public constructor() {
    super('Historical release is unavailable');
    this.name = 'AssistantHistorySourceUnavailableError';
  }
}

type DraftWrite = Parameters<AssistantLifecycleRepository['saveDraft']>[0];

const historyScope = `FROM assistant_release r
  JOIN assistant a ON a.id = r.assistant_id AND a.merchant_id = r.merchant_id
  JOIN merchant m ON m.id = a.merchant_id
  JOIN merchant_user u ON u.id = ?
  JOIN merchant_membership mm ON mm.merchant_id = a.merchant_id AND mm.merchant_user_id = u.id
 WHERE r.merchant_id = ? AND r.assistant_id = ?
   AND u.status = 'active' AND mm.status = 'active' AND m.status = 'active'
   AND r.status IN ('active','retired')`;

const historyMetadata = (row: HistoryRow): AssistantReleaseHistoryItem => {
  if (
    !Number.isSafeInteger(row.release_no) ||
    row.release_no < 1 ||
    !Number.isSafeInteger(row.draft_revision) ||
    row.draft_revision < 1 ||
    (row.status !== 'active' && row.status !== 'retired')
  )
    throw new AssistantLifecyclePersistenceError('Stored release history is invalid');
  return {
    releaseId: toReleaseId(idString(row.release_id, 'releaseId')),
    releaseNo: row.release_no,
    draftRevision: row.draft_revision,
    status: row.status,
    createdAt: validDate(row.created_at, 'createdAt'),
    activatedAt: validDate(row.activated_at, 'activatedAt'),
    isCurrent: row.active_release_id?.equals(row.release_id) ?? false,
    canRestore: ['owner', 'admin', 'editor'].includes(row.membership_role),
  };
};

export { parseDraft as parseAssistantDraft, validateDraft as validateAssistantDraft };

const OPERATION_GENERATE = 'assistant.generate';
const OPERATION_CREATE_MANUAL = 'assistant.create_manual';
const OPERATION_PUBLISH = 'assistant.publish';
const MANUAL_KNOWLEDGE_PARSER = 'merchant-confirmed-v1';
const controlCharacters = /[\u0000-\u001f\u007f]/u;

const newId = (): Buffer => randomBytes(16);
const newPublicSlug = (): string => `a-${randomBytes(18).toString('hex')}`;

const idBuffer = (value: string, field: string): Buffer => {
  if (!/^[0-9a-f]{32}$/iu.test(value)) {
    throw new AssistantLifecyclePersistenceError(`${field} must be a 32-character hex ID`);
  }
  return Buffer.from(value, 'hex');
};

const idString = (value: Buffer, field: string): string => {
  if (value.byteLength !== 16) {
    throw new AssistantLifecyclePersistenceError(`${field} must contain exactly 16 bytes`);
  }
  return value.toString('hex');
};

const strictDigest = (value: Uint8Array, field: string): Buffer => {
  if (value.byteLength !== 32) {
    throw new AssistantLifecyclePersistenceError(`${field} must contain exactly 32 bytes`);
  }
  return Buffer.from(value);
};

const validDate = (value: Date, field: string): Date => {
  if (!Number.isFinite(value.getTime())) {
    throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
  }
  return value;
};

const parseObject = (
  value: string | Record<string, unknown>,
  field: string,
): Record<string, unknown> => {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
  }
  return parsed as Record<string, unknown>;
};

const parseArray = (value: string | readonly unknown[], field: string): readonly unknown[] => {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
    }
  }
  if (!Array.isArray(parsed)) throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
  return parsed;
};

const text = (value: unknown, field: string, maximum: number): string => {
  if (typeof value !== 'string')
    throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    controlCharacters.test(normalized)
  ) {
    throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
  }
  return normalized;
};

const paragraphText = (value: unknown, field: string, maximum: number): string => {
  if (typeof value !== 'string') {
    throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
  }
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(normalized)
  )
    throw new AssistantLifecyclePersistenceError(`${field} is invalid`);
  return normalized;
};

const validateDraft = (draft: AssistantDraftConfig): AssistantDraftConfig => {
  const humanContact = normalizeHumanContact(draft.humanContact);
  if (humanContact === null)
    throw new AssistantLifecyclePersistenceError('humanContact is invalid');
  return {
    industry: text(draft.industry, 'industry', 128),
    businessScope: paragraphText(draft.businessScope, 'businessScope', 2_000),
    materialsSummary: paragraphText(draft.materialsSummary, 'materialsSummary', 4_000),
    pricingSummary: paragraphText(draft.pricingSummary, 'pricingSummary', 4_000),
    promotionSummary: paragraphText(draft.promotionSummary, 'promotionSummary', 4_000),
    welcomeMessage: text(draft.welcomeMessage, 'welcomeMessage', 500),
    insufficientInfoMessage: text(draft.insufficientInfoMessage, 'insufficientInfoMessage', 500),
    // Omit an empty new field to preserve hashes of already-confirmed legacy drafts.
    ...(humanContact ? { humanContact } : {}),
  };
};

const parseDraft = (value: string | Record<string, unknown>): AssistantDraftConfig => {
  const object = parseObject(value, 'draft config');
  return validateDraft({
    industry: text(object['industry'], 'industry', 128),
    businessScope: paragraphText(object['businessScope'], 'businessScope', 2_000),
    materialsSummary: paragraphText(object['materialsSummary'], 'materialsSummary', 4_000),
    pricingSummary: paragraphText(object['pricingSummary'], 'pricingSummary', 4_000),
    promotionSummary: paragraphText(object['promotionSummary'], 'promotionSummary', 4_000),
    welcomeMessage: text(object['welcomeMessage'], 'welcomeMessage', 500),
    insufficientInfoMessage: text(
      object['insufficientInfoMessage'],
      'insufficientInfoMessage',
      500,
    ),
    ...(object['humanContact'] === undefined
      ? {}
      : { humanContact: object['humanContact'] as string }),
  });
};

const draftConfirmed = (
  validationValue: string | Record<string, unknown>,
  draft: AssistantDraftConfig,
  revision: number,
): boolean => {
  const validation = parseObject(validationValue, 'draft validation');
  return (
    validation['publishable'] === true &&
    validation['confirmedRevision'] === revision &&
    validation['contentHash'] ===
      createHash('sha256').update(JSON.stringify(draft), 'utf8').digest('hex') &&
    typeof validation['knowledgeRevisionId'] === 'string' &&
    /^[0-9a-f]{32}$/u.test(validation['knowledgeRevisionId'])
  );
};

const parseStatus = (value: string): AssistantManagementSnapshot['status'] => {
  if (value !== 'draft_only' && value !== 'active' && value !== 'paused') {
    throw new AssistantLifecyclePersistenceError('Stored assistant status is invalid');
  }
  return value;
};

const slugDigest = (slug: string): Buffer => createHash('sha256').update(slug, 'utf8').digest();

const summarizeMaterials = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AssistantGenerationUnavailableError();
  }
  return text(
    value
      .map((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          throw new AssistantGenerationUnavailableError();
        }
        return text((item as Record<string, unknown>)['summary'], 'material summary', 500);
      })
      .join('；'),
    'materialsSummary',
    4_000,
  );
};

const summarizeFacts = (value: unknown, kind: 'pricing' | 'promotion'): string => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AssistantGenerationUnavailableError();
  }
  const policy = value as Record<string, unknown>;
  const availability = policy['availability'];
  if (availability === 'none_confirmed') {
    return kind === 'pricing' ? '已确认暂无价格信息' : '已确认暂无优惠信息';
  }
  if (availability === 'unknown') {
    return kind === 'pricing' ? '价格信息尚未确认' : '优惠信息尚未确认';
  }
  if (
    availability !== 'provided' ||
    !Array.isArray(policy['facts']) ||
    policy['facts'].length === 0
  ) {
    throw new AssistantGenerationUnavailableError();
  }
  const summary = policy['facts']
    .map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new AssistantGenerationUnavailableError();
      }
      const fact = item as Record<string, unknown>;
      if (kind === 'pricing') {
        const name = text(fact['offeringName'], 'pricing offeringName', 200);
        const amount = text(fact['amount'], 'pricing amount', 64);
        const currency = text(fact['currency'], 'pricing currency', 16);
        const conditions =
          fact['conditions'] === undefined
            ? ''
            : `（${text(fact['conditions'], 'pricing conditions', 300)}）`;
        return `${name}：${amount} ${currency}${conditions}`;
      }
      const name = text(fact['name'], 'promotion name', 200);
      const description = text(fact['description'], 'promotion description', 500);
      return `${name}：${description}`;
    })
    .join('；');
  return text(summary, `${kind}Summary`, 4_000);
};

const validateIdempotency = (value: AssistantLifecycleIdempotency, now: Date) => {
  const actorScopeDigest = strictDigest(value.actorScopeDigest, 'actorScopeDigest');
  const keyDigest = strictDigest(value.keyDigest, 'keyDigest');
  const requestHash = strictDigest(value.requestHash, 'requestHash');
  validDate(value.expiresAt, 'idempotency.expiresAt');
  if (value.expiresAt.getTime() <= now.getTime()) {
    throw new AssistantLifecyclePersistenceError('Idempotency expiry must be in the future');
  }
  return { actorScopeDigest, keyDigest, requestHash };
};

const isDuplicateKey = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062;
};

export class MySqlAssistantLifecycleRepository implements AssistantLifecycleRepository {
  readonly #config: DatabaseConnectionConfig;
  readonly #idFactory: () => Buffer;
  readonly #slugFactory: () => string;

  public constructor(
    config: DatabaseConnectionConfig,
    factories: Readonly<{ id?: () => Buffer; slug?: () => string }> = {},
  ) {
    this.#config = config;
    this.#idFactory = factories.id ?? newId;
    this.#slugFactory = factories.slug ?? newPublicSlug;
  }

  public async assertReady(): Promise<void> {
    const probe = await probeDatabase(this.#config);
    if (!probe.ok) throw new AssistantLifecyclePersistenceError();
  }

  public async listMerchantAssistants(
    merchantUserIdValue: MerchantUserId,
    merchantIdValue: MerchantId,
  ): Promise<readonly AssistantManagementSnapshot[]> {
    const merchantUserId = idBuffer(merchantUserIdValue, 'merchantUserId');
    const merchantId = idBuffer(merchantIdValue, 'merchantId');
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<ManagementRow[]>(
        `SELECT a.id AS assistant_id, a.merchant_id, a.display_name, a.public_slug,
                a.status, a.draft_revision, d.config, d.validation, a.active_release_id,
                a.created_at, a.updated_at
           FROM assistant a
           JOIN assistant_draft d ON d.merchant_id = a.merchant_id AND d.assistant_id = a.id
           JOIN merchant m ON m.id = a.merchant_id
           JOIN merchant_membership mm ON mm.merchant_id = m.id
          WHERE a.merchant_id = ? AND mm.merchant_user_id = ?
            AND m.status = 'active' AND mm.status = 'active'
          ORDER BY a.created_at DESC, a.id DESC LIMIT 50`,
        [merchantId, merchantUserId],
      );
      return rows.map((row) => this.#managementFromRow(row));
    });
  }

  public async createManualDraft(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    displayName: string;
    draft: AssistantDraftConfig;
    idempotency: AssistantLifecycleIdempotency;
    now: Date;
  }): Promise<AssistantManagementSnapshot> {
    validDate(input.now, 'now');
    const merchantUserId = idBuffer(input.merchantUserId, 'merchantUserId');
    const merchantId = idBuffer(input.merchantId, 'merchantId');
    const displayName = text(input.displayName, 'displayName', 200);
    const draft = validateDraft(input.draft);
    const idem = validateIdempotency(input.idempotency, input.now);
    try {
      return await this.#withTransaction(async (connection) => {
        const [memberships] = await connection.execute<RowDataPacket[]>(
          `SELECT mm.merchant_id
             FROM merchant_membership mm
             JOIN merchant m ON m.id = mm.merchant_id
             JOIN merchant_user u ON u.id = mm.merchant_user_id
            WHERE mm.merchant_id = ? AND mm.merchant_user_id = ?
              AND mm.status = 'active' AND m.status = 'active' AND u.status = 'active'
              AND mm.role IN ('owner','admin','editor')
            LIMIT 1 FOR UPDATE`,
          [merchantId, merchantUserId],
        );
        if (memberships.length !== 1) throw new AssistantGenerationUnavailableError();
        const idempotencyId = this.#newId('idempotencyId');
        await this.#insertIdempotency(
          connection,
          idempotencyId,
          merchantId,
          OPERATION_CREATE_MANUAL,
          idem,
          input.idempotency.expiresAt,
        );
        const assistantId = this.#newId('assistantId');
        const slug = this.#newSlug();
        await connection.execute(
          `INSERT INTO assistant
             (id, merchant_id, display_name, public_slug, public_slug_digest, status,
              active_release_id, draft_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft_only', NULL, 1, ?, ?)`,
          [assistantId, merchantId, displayName, slug, slugDigest(slug), input.now, input.now],
        );
        await connection.execute(
          `INSERT INTO assistant_draft
             (assistant_id, merchant_id, revision, config, validation, updated_by, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
          [
            assistantId,
            merchantId,
            JSON.stringify(draft),
            JSON.stringify({ publishable: false, reason: 'knowledge_not_verified' }),
            merchantUserId,
            input.now,
          ],
        );
        await this.#completeIdempotency(
          connection,
          idempotencyId,
          assistantId,
          'assistant',
          { assistantId: assistantId.toString('hex'), merchantId: input.merchantId },
          input.now,
        );
        await this.#writeOutbox(
          connection,
          merchantId,
          'assistant.created',
          'assistant',
          assistantId,
          { draftRevision: 1 },
          input.now,
        );
        return {
          assistantId: toAssistantId(assistantId.toString('hex')),
          merchantId: input.merchantId,
          displayName,
          publicSlug: slug,
          status: 'draft_only',
          draftRevision: 1,
          draft,
          knowledgeConfirmed: false,
          activeReleaseId: null,
          createdAt: input.now,
          updatedAt: input.now,
        };
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return this.#recoverCreated(OPERATION_CREATE_MANUAL, input, idem);
    }
  }

  public async generateDraftFromOnboarding(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    onboardingSessionId: OnboardingSessionId;
    idempotency: AssistantLifecycleIdempotency;
    now: Date;
  }): Promise<AssistantManagementSnapshot> {
    validDate(input.now, 'now');
    const merchantUserId = idBuffer(input.merchantUserId, 'merchantUserId');
    const merchantId = idBuffer(input.merchantId, 'merchantId');
    const sessionId = idBuffer(input.onboardingSessionId, 'onboardingSessionId');
    const idem = validateIdempotency(input.idempotency, input.now);
    try {
      return await this.#withTransaction(async (connection) => {
        const idempotencyId = this.#newId('idempotencyId');
        await this.#insertIdempotency(
          connection,
          idempotencyId,
          merchantId,
          OPERATION_GENERATE,
          idem,
          input.idempotency.expiresAt,
        );
        const [rows] = await connection.execute<OnboardingGenerationRow[]>(
          `SELECT s.answers, s.missing_items, s.version
             FROM onboarding_session s
             JOIN merchant_user u ON u.id = s.merchant_user_id
             JOIN merchant m ON m.id = s.merchant_id
             JOIN merchant_membership mm
               ON mm.merchant_id = s.merchant_id AND mm.merchant_user_id = s.merchant_user_id
            WHERE s.id = ? AND s.merchant_user_id = ? AND s.merchant_id = ?
              AND s.state = 'generating' AND s.assistant_id IS NULL
              AND u.status = 'active' AND m.status = 'active' AND mm.status = 'active'
              AND mm.role IN ('owner','admin','editor')
            LIMIT 1
            FOR UPDATE`,
          [sessionId, merchantUserId, merchantId],
        );
        const onboarding = rows[0];
        if (
          onboarding === undefined ||
          parseArray(onboarding.missing_items, 'missingItems').length > 0
        ) {
          throw new AssistantGenerationUnavailableError();
        }
        const answers = parseObject(onboarding.answers, 'onboarding answers');
        if (answers['merchantConfirmed'] !== true) throw new AssistantGenerationUnavailableError();
        const businessName = text(answers['businessName'], 'businessName', 180);
        const displayName = text(`${businessName}客服`, 'displayName', 200);
        const draft = validateDraft({
          industry: text(answers['industryCode'], 'industryCode', 128),
          businessScope: text(answers['businessDescription'], 'businessDescription', 2_000),
          materialsSummary: summarizeMaterials(answers['materials']),
          pricingSummary: summarizeFacts(answers['pricingPolicy'], 'pricing'),
          promotionSummary: summarizeFacts(answers['promotionPolicy'], 'promotion'),
          welcomeMessage: `你好，我是${displayName}。`,
          insufficientInfoMessage:
            answers['insufficientFactPolicy'] === 'contact_merchant'
              ? '当前资料不足，请联系商家确认。'
              : '当前资料尚未确认，我会明确说明未知信息。',
        });
        const assistantId = this.#newId('assistantId');
        const slug = this.#newSlug();
        await connection.execute(
          `INSERT INTO assistant
             (id, merchant_id, display_name, public_slug, public_slug_digest, status,
              active_release_id, draft_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft_only', NULL, 1, ?, ?)`,
          [assistantId, merchantId, displayName, slug, slugDigest(slug), input.now, input.now],
        );
        await connection.execute(
          `INSERT INTO assistant_draft
             (assistant_id, merchant_id, revision, config, validation, updated_by, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
          [
            assistantId,
            merchantId,
            JSON.stringify(draft),
            JSON.stringify({ publishable: false, reason: 'knowledge_not_verified' }),
            merchantUserId,
            input.now,
          ],
        );
        const [sessionResult] = await connection.execute<ResultSetHeader>(
          `UPDATE onboarding_session
              SET assistant_id = ?, state = 'manageable', missing_items = JSON_ARRAY(),
                  version = version + 1, completed_at = ?, updated_at = ?
            WHERE id = ? AND merchant_user_id = ? AND merchant_id = ?
              AND state = 'generating' AND assistant_id IS NULL AND version = ?`,
          [
            assistantId,
            input.now,
            input.now,
            sessionId,
            merchantUserId,
            merchantId,
            onboarding.version,
          ],
        );
        if (sessionResult.affectedRows !== 1) throw new AssistantGenerationUnavailableError();
        const response = {
          assistantId: assistantId.toString('hex'),
          merchantId: input.merchantId,
        };
        await this.#completeIdempotency(
          connection,
          idempotencyId,
          assistantId,
          'assistant',
          response,
          input.now,
        );
        await this.#writeOutbox(
          connection,
          merchantId,
          'assistant.created',
          'assistant',
          assistantId,
          { draftRevision: 1 },
          input.now,
        );
        return {
          assistantId: toAssistantId(assistantId.toString('hex')),
          merchantId: input.merchantId,
          displayName,
          publicSlug: slug,
          status: 'draft_only',
          draftRevision: 1,
          draft,
          knowledgeConfirmed: false,
          activeReleaseId: null,
          createdAt: input.now,
          updatedAt: input.now,
        };
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return this.#recoverCreated(OPERATION_GENERATE, input, idem);
    }
  }

  public async findManagementSnapshot(
    merchantIdValue: MerchantId,
    assistantIdValue: AssistantId,
  ): Promise<AssistantManagementSnapshot | null> {
    const merchantId = idBuffer(merchantIdValue, 'merchantId');
    const assistantId = idBuffer(assistantIdValue, 'assistantId');
    return this.#withConnection(async (connection) =>
      this.#findManagement(connection, merchantId, assistantId),
    );
  }

  public async saveDraft(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    assistantId: AssistantId;
    expectedRevision: number;
    draft: AssistantDraftConfig;
    now: Date;
  }): Promise<AssistantManagementSnapshot> {
    const draft = validateDraft(input.draft);
    validDate(input.now, 'now');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new AssistantLifecyclePersistenceError('expectedRevision is invalid');
    }
    const merchantUserId = idBuffer(input.merchantUserId, 'merchantUserId');
    const merchantId = idBuffer(input.merchantId, 'merchantId');
    const assistantId = idBuffer(input.assistantId, 'assistantId');
    return this.#withTransaction(async (connection) => {
      const current = await this.#lockManagement(
        connection,
        merchantUserId,
        merchantId,
        assistantId,
      );
      if (current === null) throw new AssistantRevisionConflictError();
      return this.#persistDraft(connection, current, input, draft);
    });
  }

  public async listReleaseHistory(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    assistantId: AssistantId;
    beforeReleaseNo?: number;
  }): Promise<
    Readonly<{ items: readonly AssistantReleaseHistoryItem[]; nextBeforeReleaseNo: number | null }>
  > {
    const user = idBuffer(input.merchantUserId, 'merchantUserId');
    const merchant = idBuffer(input.merchantId, 'merchantId');
    const assistant = idBuffer(input.assistantId, 'assistantId');
    const before = input.beforeReleaseNo ?? null;
    if (before !== null && (!Number.isSafeInteger(before) || before < 1))
      throw new AssistantLifecyclePersistenceError('History cursor is invalid');
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<HistoryRow[]>(
        `SELECT r.id AS release_id, r.release_no, r.draft_revision, r.status,
                r.created_at, r.activated_at, a.active_release_id, mm.role AS membership_role
          ${historyScope} AND (? IS NULL OR r.release_no < ?)
          ORDER BY r.release_no DESC LIMIT 21`,
        [user, merchant, assistant, before, before],
      );
      const items = rows.slice(0, 20).map(historyMetadata);
      return { items, nextBeforeReleaseNo: rows.length > 20 ? items.at(-1)!.releaseNo : null };
    });
  }

  public async findReleaseHistorySnapshot(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    assistantId: AssistantId;
    releaseId: ReleaseId;
  }): Promise<AssistantReleaseHistorySnapshot | null> {
    const user = idBuffer(input.merchantUserId, 'merchantUserId');
    const merchant = idBuffer(input.merchantId, 'merchantId');
    const assistant = idBuffer(input.assistantId, 'assistantId');
    const release = idBuffer(input.releaseId, 'releaseId');
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<HistoryRow[]>(
        `SELECT r.id AS release_id, r.release_no, r.draft_revision, r.status,
                r.created_at, r.activated_at, r.config_snapshot,
                a.active_release_id, mm.role AS membership_role
          ${historyScope} AND r.id = ? LIMIT 1`,
        [user, merchant, assistant, release],
      );
      const row = rows[0];
      return row ? { ...historyMetadata(row), draft: parseDraft(row.config_snapshot) } : null;
    });
  }

  public async restoreDraftFromRelease(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    assistantId: AssistantId;
    releaseId: ReleaseId;
    expectedRevision: number;
    now: Date;
  }): Promise<Readonly<{ assistant: AssistantManagementSnapshot; sourceReleaseNo: number }>> {
    validDate(input.now, 'now');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw new AssistantLifecyclePersistenceError('expectedRevision is invalid');
    const user = idBuffer(input.merchantUserId, 'merchantUserId');
    const merchant = idBuffer(input.merchantId, 'merchantId');
    const assistant = idBuffer(input.assistantId, 'assistantId');
    const release = idBuffer(input.releaseId, 'releaseId');
    return this.#withTransaction(async (connection) => {
      // Recheck the editor role and current revision under the existing tenant lock.
      const current = await this.#lockManagement(connection, user, merchant, assistant);
      if (!current || current.draft_revision !== input.expectedRevision)
        throw new AssistantRevisionConflictError();
      const [rows] = await connection.execute<HistoryRow[]>(
        `SELECT id AS release_id, release_no, config_snapshot FROM assistant_release
          WHERE merchant_id = ? AND assistant_id = ? AND id = ?
            AND status IN ('active','retired') LIMIT 1`,
        [merchant, assistant, release],
      );
      const source = rows[0];
      if (!source || !Number.isSafeInteger(source.release_no) || source.release_no < 1)
        throw new AssistantHistorySourceUnavailableError();
      const draft = parseDraft(source.config_snapshot);
      const saved = await this.#persistDraft(connection, current, { ...input, draft }, draft);
      const auditId = this.#newId('auditId');
      await connection.execute(
        `INSERT INTO audit_log
           (id, merchant_id, actor_type, actor_id, action, target_type, target_id,
            result, request_id, metadata, occurred_at, created_at)
         VALUES (?, ?, 'merchant_user', ?, 'assistant.draft_restore', 'assistant', ?,
                 'success', ?, ?, ?, ?)`,
        [
          auditId,
          merchant,
          input.merchantUserId,
          input.assistantId,
          `assistant-restore-${auditId.toString('hex')}`,
          JSON.stringify({
            sourceReleaseId: input.releaseId,
            sourceReleaseNo: source.release_no,
            previousDraftRevision: input.expectedRevision,
            draftRevision: saved.draftRevision,
            publicReleaseUnchanged: true,
          }),
          input.now,
          input.now,
        ],
      );
      return { assistant: saved, sourceReleaseNo: source.release_no };
    });
  }

  public async confirmDraftKnowledge(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    assistantId: AssistantId;
    expectedDraftRevision: number;
    now: Date;
  }): Promise<{ knowledgeRevisionId: string; draftRevision: number }> {
    validDate(input.now, 'now');
    if (!Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 1) {
      throw new AssistantLifecyclePersistenceError('expectedDraftRevision is invalid');
    }
    const merchantUserId = idBuffer(input.merchantUserId, 'merchantUserId');
    const merchantId = idBuffer(input.merchantId, 'merchantId');
    const assistantId = idBuffer(input.assistantId, 'assistantId');
    return this.#withTransaction(async (connection) => {
      const current = await this.#lockManagement(
        connection,
        merchantUserId,
        merchantId,
        assistantId,
      );
      if (
        current === null ||
        current.draft_revision !== input.expectedDraftRevision ||
        current.status === 'paused'
      )
        throw new AssistantRevisionConflictError();
      const draft = parseDraft(current.config);
      const contentHash = createHash('sha256').update(JSON.stringify(draft), 'utf8').digest();
      const previous = parseObject(current.validation, 'draft validation');
      if (
        previous['publishable'] === true &&
        previous['confirmedRevision'] === input.expectedDraftRevision &&
        previous['contentHash'] === contentHash.toString('hex') &&
        typeof previous['knowledgeRevisionId'] === 'string' &&
        /^[0-9a-f]{32}$/u.test(previous['knowledgeRevisionId']) &&
        (await this.#knowledgeReady(
          connection,
          merchantId,
          assistantId,
          idBuffer(previous['knowledgeRevisionId'], 'knowledgeRevisionId'),
          contentHash,
          input.now,
        ))
      ) {
        return {
          knowledgeRevisionId: previous['knowledgeRevisionId'],
          draftRevision: input.expectedDraftRevision,
        };
      }
      const sourceId = this.#newId('knowledgeSourceId');
      const knowledgeRevisionId = this.#newId('knowledgeRevisionId');
      await connection.execute(
        `INSERT INTO knowledge_source
           (id, merchant_id, assistant_id, type, title, status, current_revision_no,
            created_at, updated_at)
         VALUES (?, ?, ?, 'merchant_confirmed_text', ?, 'active', 1, ?, ?)`,
        [
          sourceId,
          merchantId,
          assistantId,
          `${current.display_name}：商家确认资料`,
          input.now,
          input.now,
        ],
      );
      await connection.execute(
        `INSERT INTO knowledge_revision
           (id, merchant_id, assistant_id, source_id, revision_no, status, content_hash,
            source_metadata, parser_version, effective_from, created_at, processed_at)
         VALUES (?, ?, ?, ?, 1, 'ready', ?, ?, ?, ?, ?, ?)`,
        [
          knowledgeRevisionId,
          merchantId,
          assistantId,
          sourceId,
          contentHash,
          JSON.stringify({
            kind: 'merchant_confirmed_text',
            draftRevision: input.expectedDraftRevision,
            facts: draft,
          }),
          MANUAL_KNOWLEDGE_PARSER,
          input.now,
          input.now,
          input.now,
        ],
      );
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE assistant_draft
            SET validation = ?, updated_by = ?, updated_at = ?
          WHERE merchant_id = ? AND assistant_id = ? AND revision = ?`,
        [
          JSON.stringify({
            publishable: true,
            confirmedRevision: input.expectedDraftRevision,
            knowledgeRevisionId: knowledgeRevisionId.toString('hex'),
            contentHash: contentHash.toString('hex'),
          }),
          merchantUserId,
          input.now,
          merchantId,
          assistantId,
          input.expectedDraftRevision,
        ],
      );
      if (updated.affectedRows !== 1) throw new AssistantRevisionConflictError();
      await this.#writeOutbox(
        connection,
        merchantId,
        'knowledge.confirmed',
        'knowledge_revision',
        knowledgeRevisionId,
        { assistantId: input.assistantId, draftRevision: input.expectedDraftRevision },
        input.now,
      );
      return {
        knowledgeRevisionId: knowledgeRevisionId.toString('hex'),
        draftRevision: input.expectedDraftRevision,
      };
    });
  }

  public async publish(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    assistantId: AssistantId;
    expectedDraftRevision: number;
    promptTemplateVersion: string;
    retrievalPolicyVersion: string;
    modelPolicyVersion: string;
    idempotency: AssistantLifecycleIdempotency;
    now: Date;
  }): Promise<AssistantReleaseRecord> {
    validDate(input.now, 'now');
    if (!Number.isSafeInteger(input.expectedDraftRevision) || input.expectedDraftRevision < 1) {
      throw new AssistantLifecyclePersistenceError('expectedDraftRevision is invalid');
    }
    const versions = {
      prompt: text(input.promptTemplateVersion, 'promptTemplateVersion', 64),
      retrieval: text(input.retrievalPolicyVersion, 'retrievalPolicyVersion', 64),
      model: text(input.modelPolicyVersion, 'modelPolicyVersion', 64),
    };
    const merchantUserId = idBuffer(input.merchantUserId, 'merchantUserId');
    const merchantId = idBuffer(input.merchantId, 'merchantId');
    const assistantId = idBuffer(input.assistantId, 'assistantId');
    const idem = validateIdempotency(input.idempotency, input.now);
    try {
      return await this.#withTransaction(async (connection) => {
        const idempotencyId = this.#newId('idempotencyId');
        await this.#insertIdempotency(
          connection,
          idempotencyId,
          merchantId,
          OPERATION_PUBLISH,
          idem,
          input.idempotency.expiresAt,
        );
        const current = await this.#lockManagement(
          connection,
          merchantUserId,
          merchantId,
          assistantId,
        );
        if (
          current === null ||
          current.draft_revision !== input.expectedDraftRevision ||
          current.status === 'paused'
        ) {
          throw new AssistantPublishValidationError();
        }
        const validation = parseObject(current.validation, 'draft validation');
        const draft = parseDraft(current.config);
        const contentHash = createHash('sha256').update(JSON.stringify(draft), 'utf8').digest();
        if (
          validation['publishable'] !== true ||
          validation['confirmedRevision'] !== input.expectedDraftRevision ||
          validation['contentHash'] !== contentHash.toString('hex') ||
          typeof validation['knowledgeRevisionId'] !== 'string' ||
          !/^[0-9a-f]{32}$/u.test(validation['knowledgeRevisionId'])
        ) {
          throw new AssistantPublishValidationError();
        }
        const knowledgeRevisionId = idBuffer(
          validation['knowledgeRevisionId'],
          'knowledgeRevisionId',
        );
        if (
          !(await this.#knowledgeReady(
            connection,
            merchantId,
            assistantId,
            knowledgeRevisionId,
            contentHash,
            input.now,
          ))
        )
          throw new AssistantPublishValidationError();
        const [releaseRows] = await connection.execute<(RowDataPacket & { release_no: number })[]>(
          `SELECT release_no
             FROM assistant_release
            WHERE merchant_id = ? AND assistant_id = ?
            ORDER BY release_no DESC
            LIMIT 1
            FOR UPDATE`,
          [merchantId, assistantId],
        );
        const releaseNo = (releaseRows[0]?.release_no ?? 0) + 1;
        const releaseId = this.#newId('releaseId');
        const configSnapshot = {
          draftRevision: input.expectedDraftRevision,
          knowledgeRevisionId: validation['knowledgeRevisionId'],
          displayName: current.display_name,
          ...draft,
        };
        if (current.active_release_id !== null) {
          const [retireResult] = await connection.execute<ResultSetHeader>(
            `UPDATE assistant_release
                SET status = 'retired'
              WHERE merchant_id = ? AND assistant_id = ? AND id = ? AND status = 'active'`,
            [merchantId, assistantId, current.active_release_id],
          );
          if (retireResult.affectedRows !== 1) throw new AssistantPublishValidationError();
        }
        await connection.execute(
          `INSERT INTO assistant_release
             (id, merchant_id, assistant_id, release_no, draft_revision, status,
              config_snapshot, prompt_template_version, retrieval_policy_version,
              model_policy_version, created_by, created_at, activated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
          [
            releaseId,
            merchantId,
            assistantId,
            releaseNo,
            input.expectedDraftRevision,
            JSON.stringify(configSnapshot),
            versions.prompt,
            versions.retrieval,
            versions.model,
            merchantUserId,
            input.now,
            input.now,
          ],
        );
        await connection.execute(
          `INSERT INTO assistant_active_release
             (merchant_id, assistant_id, release_id, activated_at)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE release_id = VALUES(release_id),
                                   activated_at = VALUES(activated_at)`,
          [merchantId, assistantId, releaseId, input.now],
        );
        const [assistantResult] = await connection.execute<ResultSetHeader>(
          `UPDATE assistant
              SET active_release_id = ?, status = 'active', updated_at = ?
            WHERE merchant_id = ? AND id = ? AND draft_revision = ?`,
          [releaseId, input.now, merchantId, assistantId, input.expectedDraftRevision],
        );
        if (assistantResult.affectedRows !== 1) throw new AssistantRevisionConflictError();
        await bindVerifiedImprovementsToRelease(connection, {
          merchantId,
          assistantId,
          releaseId,
          draftRevision: input.expectedDraftRevision,
          factsHash: contentHash,
          promptTemplateVersion: versions.prompt,
          modelPolicyVersion: versions.model,
          now: input.now,
        });
        const response = {
          releaseId: releaseId.toString('hex'),
          assistantId: input.assistantId,
          merchantId: input.merchantId,
          releaseNo,
          draftRevision: input.expectedDraftRevision,
          createdAt: input.now.toISOString(),
        };
        await this.#completeIdempotency(
          connection,
          idempotencyId,
          releaseId,
          'assistant_release',
          response,
          input.now,
        );
        await this.#writeOutbox(
          connection,
          merchantId,
          'release.activated',
          'assistant_release',
          releaseId,
          { assistantId: input.assistantId, releaseNo, draftRevision: input.expectedDraftRevision },
          input.now,
        );
        return {
          releaseId: toReleaseId(releaseId.toString('hex')),
          merchantId: input.merchantId,
          assistantId: input.assistantId,
          releaseNo,
          status: 'active',
          draftRevision: input.expectedDraftRevision,
          createdAt: input.now,
          activatedAt: input.now,
        };
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return this.#recoverPublished(input, idem);
    }
  }

  public async findPublicSnapshot(publicSlug: string): Promise<PublicAssistantSnapshot | null> {
    const slug = text(publicSlug, 'publicSlug', 128);
    if (slug !== slug.toLowerCase() || !/^[a-z0-9-]{1,63}$/u.test(slug)) return null;
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<PublicRow[]>(
        `SELECT a.public_slug, r.id AS release_id, m.name AS merchant_name,
                a.display_name, r.config_snapshot
           FROM assistant a
           JOIN assistant_active_release ar
             ON ar.merchant_id = a.merchant_id AND ar.assistant_id = a.id
            AND ar.release_id = a.active_release_id
           JOIN assistant_release r
             ON r.merchant_id = ar.merchant_id AND r.assistant_id = ar.assistant_id
            AND r.id = ar.release_id
           JOIN merchant m ON m.id = a.merchant_id
          WHERE a.public_slug_digest = ? AND a.public_slug = ?
            AND a.status = 'active' AND r.status = 'active' AND m.status = 'active'
          LIMIT 2`,
        [slugDigest(slug), slug],
      );
      if (rows.length !== 1) return null;
      const row = rows[0];
      if (row === undefined || row.public_slug !== slug) return null;
      const snapshot = parseObject(row.config_snapshot, 'release config');
      const draft = parseDraft(snapshot);
      const assistantName = text(snapshot['displayName'], 'displayName', 200);
      if (assistantName !== row.display_name) return null;
      return {
        publicAssistantId: row.public_slug,
        releaseRef: idString(row.release_id, 'releaseId'),
        merchantName: text(row.merchant_name, 'merchantName', 200),
        assistantName,
        businessScope: draft.businessScope,
        welcomeMessage: draft.welcomeMessage,
        insufficientInfoMessage: draft.insufficientInfoMessage,
        humanContact: draft.humanContact ?? '',
        availability: 'online',
      };
    });
  }

  async #findManagement(
    connection: Connection,
    merchantId: Buffer,
    assistantId: Buffer,
  ): Promise<AssistantManagementSnapshot | null> {
    const [rows] = await connection.execute<ManagementRow[]>(
      `SELECT a.id AS assistant_id, a.merchant_id, a.display_name, a.public_slug,
              a.status, a.draft_revision, d.config, d.validation, a.active_release_id,
              a.created_at, a.updated_at
         FROM assistant a
         JOIN assistant_draft d
           ON d.merchant_id = a.merchant_id AND d.assistant_id = a.id
        WHERE a.merchant_id = ? AND a.id = ?
        LIMIT 1`,
      [merchantId, assistantId],
    );
    const row = rows[0];
    return row === undefined ? null : this.#managementFromRow(row);
  }

  async #lockManagement(
    connection: Connection,
    merchantUserId: Buffer,
    merchantId: Buffer,
    assistantId: Buffer,
  ): Promise<PublishRow | null> {
    const [rows] = await connection.execute<PublishRow[]>(
      `SELECT a.id AS assistant_id, a.merchant_id, a.display_name, a.public_slug,
              a.status, a.draft_revision, d.config, d.validation, a.active_release_id,
              a.created_at, a.updated_at, mm.status AS membership_status,
              m.status AS merchant_status
         FROM assistant a
         JOIN assistant_draft d
           ON d.merchant_id = a.merchant_id AND d.assistant_id = a.id
         JOIN merchant m ON m.id = a.merchant_id
         JOIN merchant_user u ON u.id = ?
         JOIN merchant_membership mm
           ON mm.merchant_id = a.merchant_id AND mm.merchant_user_id = u.id
        WHERE a.merchant_id = ? AND a.id = ?
          AND u.status = 'active' AND mm.status = 'active' AND m.status = 'active'
          AND mm.role IN ('owner','admin','editor')
        LIMIT 1
        FOR UPDATE`,
      [merchantUserId, merchantId, assistantId],
    );
    return rows[0] ?? null;
  }

  async #persistDraft(
    connection: Connection,
    current: PublishRow,
    input: DraftWrite,
    draft: AssistantDraftConfig,
  ): Promise<AssistantManagementSnapshot> {
    if (current.draft_revision !== input.expectedRevision)
      throw new AssistantRevisionConflictError();
    const nextRevision = input.expectedRevision + 1;
    const merchant = idBuffer(input.merchantId, 'merchantId');
    const assistant = idBuffer(input.assistantId, 'assistantId');
    const user = idBuffer(input.merchantUserId, 'merchantUserId');
    const [draftResult] = await connection.execute<ResultSetHeader>(
      `UPDATE assistant_draft
          SET revision = ?, config = ?, validation = ?, updated_by = ?, updated_at = ?
        WHERE merchant_id = ? AND assistant_id = ? AND revision = ?`,
      [
        nextRevision,
        JSON.stringify(draft),
        JSON.stringify({ publishable: false, reason: 'knowledge_not_verified' }),
        user,
        input.now,
        merchant,
        assistant,
        input.expectedRevision,
      ],
    );
    const [assistantResult] = await connection.execute<ResultSetHeader>(
      `UPDATE assistant
          SET draft_revision = ?, updated_at = ?
        WHERE merchant_id = ? AND id = ? AND draft_revision = ?`,
      [nextRevision, input.now, merchant, assistant, input.expectedRevision],
    );
    if (draftResult.affectedRows !== 1 || assistantResult.affectedRows !== 1)
      throw new AssistantRevisionConflictError();
    return {
      assistantId: input.assistantId,
      merchantId: input.merchantId,
      displayName: current.display_name,
      publicSlug: current.public_slug,
      status: parseStatus(current.status),
      draftRevision: nextRevision,
      draft,
      knowledgeConfirmed: false,
      activeReleaseId:
        current.active_release_id === null
          ? null
          : toReleaseId(idString(current.active_release_id, 'activeReleaseId')),
      createdAt: current.created_at,
      updatedAt: input.now,
    };
  }

  async #knowledgeReady(
    connection: Connection,
    merchantId: Buffer,
    assistantId: Buffer,
    knowledgeRevisionId: Buffer,
    contentHash: Buffer,
    now: Date,
  ): Promise<boolean> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT kr.id FROM knowledge_revision kr
         JOIN knowledge_source ks
           ON ks.merchant_id = kr.merchant_id AND ks.assistant_id = kr.assistant_id
          AND ks.id = kr.source_id
        WHERE kr.merchant_id = ? AND kr.assistant_id = ? AND kr.id = ?
          AND kr.status = 'ready' AND kr.content_hash = ?
          AND kr.effective_from <= ?
          AND (kr.effective_until IS NULL OR kr.effective_until > ?)
          AND ks.status = 'active'
        LIMIT 1 FOR UPDATE`,
      [merchantId, assistantId, knowledgeRevisionId, contentHash, now, now],
    );
    return rows.length === 1;
  }

  #managementFromRow(row: ManagementRow): AssistantManagementSnapshot {
    const draft = parseDraft(row.config);
    return {
      assistantId: toAssistantId(idString(row.assistant_id, 'assistantId')),
      merchantId: toMerchantId(idString(row.merchant_id, 'merchantId')),
      displayName: text(row.display_name, 'displayName', 200),
      publicSlug: text(row.public_slug, 'publicSlug', 128),
      status: parseStatus(row.status),
      draftRevision: row.draft_revision,
      draft,
      knowledgeConfirmed: draftConfirmed(row.validation, draft, row.draft_revision),
      activeReleaseId:
        row.active_release_id === null
          ? null
          : toReleaseId(idString(row.active_release_id, 'activeReleaseId')),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async #recoverCreated(
    operation: string,
    input: {
      merchantUserId: MerchantUserId;
      merchantId: MerchantId;
      idempotency: AssistantLifecycleIdempotency;
    },
    idem: Readonly<{ actorScopeDigest: Buffer; keyDigest: Buffer; requestHash: Buffer }>,
  ): Promise<AssistantManagementSnapshot> {
    const idempotency = await this.#readIdempotency(operation, idem);
    if (idempotency.resource_id === null) throw new AssistantLifecyclePersistenceError();
    // The unlocked lookup above only discovers the created assistant ID. Recovery is still
    // a currently authorized operation: acquire the assistant/member locks before returning
    // any cached success, and recheck the immutable idempotency record in that transaction.
    const assistantId = idempotency.resource_id;
    return this.#withTransaction(async (connection) => {
      const current = await this.#lockManagement(
        connection,
        idBuffer(input.merchantUserId, 'merchantUserId'),
        idBuffer(input.merchantId, 'merchantId'),
        assistantId,
      );
      if (current === null) throw new AssistantLifecyclePersistenceError();
      const verified = await this.#readIdempotency(operation, idem, connection);
      if (verified.resource_id === null || !verified.resource_id.equals(assistantId)) {
        throw new AssistantLifecyclePersistenceError();
      }
      return this.#managementFromRow(current);
    });
  }

  async #recoverPublished(
    input: { merchantUserId: MerchantUserId; merchantId: MerchantId; assistantId: AssistantId },
    idem: Readonly<{ actorScopeDigest: Buffer; keyDigest: Buffer; requestHash: Buffer }>,
  ): Promise<AssistantReleaseRecord> {
    return this.#withTransaction(async (connection) => {
      // Duplicate-key recovery must not bypass revocation or a paused merchant. The normal
      // publish path checks these under #lockManagement; recovery uses that same lock first.
      const current = await this.#lockManagement(
        connection,
        idBuffer(input.merchantUserId, 'merchantUserId'),
        idBuffer(input.merchantId, 'merchantId'),
        idBuffer(input.assistantId, 'assistantId'),
      );
      if (current === null || current.status === 'paused')
        throw new AssistantPublishValidationError();
      const idempotency = await this.#readIdempotency(OPERATION_PUBLISH, idem, connection);
      if (idempotency.resource_id === null) throw new AssistantLifecyclePersistenceError();
      const releaseId = idempotency.resource_id;
      const [rows] = await connection.execute<ReleaseRow[]>(
        `SELECT id AS release_id, merchant_id, assistant_id, release_no, draft_revision,
                created_at, activated_at
           FROM assistant_release
          WHERE merchant_id = ? AND assistant_id = ? AND id = ? AND status = 'active'
          LIMIT 1`,
        [
          idBuffer(input.merchantId, 'merchantId'),
          idBuffer(input.assistantId, 'assistantId'),
          releaseId,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new AssistantLifecyclePersistenceError();
      return {
        releaseId: toReleaseId(idString(row.release_id, 'releaseId')),
        merchantId: toMerchantId(idString(row.merchant_id, 'merchantId')),
        assistantId: toAssistantId(idString(row.assistant_id, 'assistantId')),
        releaseNo: row.release_no,
        status: 'active',
        draftRevision: row.draft_revision,
        createdAt: row.created_at,
        activatedAt: row.activated_at,
      };
    });
  }

  async #readIdempotency(
    operation: string,
    idem: Readonly<{ actorScopeDigest: Buffer; keyDigest: Buffer; requestHash: Buffer }>,
    existingConnection?: Connection,
  ): Promise<IdempotencyRow> {
    const read = async (connection: Connection): Promise<IdempotencyRow> => {
      const [rows] = await connection.execute<IdempotencyRow[]>(
        `SELECT request_hash, state, resource_id, response_body
           FROM idempotency_record
          WHERE actor_scope_digest = ? AND operation = ? AND key_digest = ?
          LIMIT 1`,
        [idem.actorScopeDigest, operation, idem.keyDigest],
      );
      const row = rows[0];
      if (row === undefined || !row.request_hash.equals(idem.requestHash)) {
        if (row !== undefined) throw new AssistantIdempotencyConflictError();
        throw new AssistantLifecyclePersistenceError();
      }
      if (row.state !== 'succeeded' || row.response_body === null) {
        throw new AssistantLifecyclePersistenceError();
      }
      return row;
    };
    return existingConnection ? read(existingConnection) : this.#withConnection(read);
  }

  async #insertIdempotency(
    connection: Connection,
    id: Buffer,
    merchantId: Buffer,
    operation: string,
    idem: Readonly<{ actorScopeDigest: Buffer; keyDigest: Buffer; requestHash: Buffer }>,
    expiresAt: Date,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO idempotency_record
         (id, merchant_id, actor_scope_digest, operation, key_digest, request_hash,
          state, resource_type, resource_id, response_code, response_body,
          expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'processing', NULL, NULL, NULL, NULL, ?,
               UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        id,
        merchantId,
        idem.actorScopeDigest,
        operation,
        idem.keyDigest,
        idem.requestHash,
        expiresAt,
      ],
    );
  }

  async #completeIdempotency(
    connection: Connection,
    id: Buffer,
    resourceId: Buffer,
    resourceType: string,
    responseBody: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE idempotency_record
          SET state = 'succeeded', resource_type = ?, resource_id = ?, response_code = 201,
              response_body = ?, updated_at = ?
        WHERE id = ? AND state = 'processing'`,
      [resourceType, resourceId, JSON.stringify(responseBody), now, id],
    );
    if (result.affectedRows !== 1) throw new AssistantLifecyclePersistenceError();
  }

  async #writeOutbox(
    connection: Connection,
    merchantId: Buffer,
    eventType: string,
    aggregateType: string,
    aggregateId: Buffer,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO outbox_event
         (id, merchant_id, event_type, aggregate_type, aggregate_id, schema_version,
          payload, state, attempt, available_at, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', 0, ?, ?, ?)`,
      [
        this.#newId('outboxId'),
        merchantId,
        eventType,
        aggregateType,
        aggregateId,
        JSON.stringify(payload),
        now,
        now,
        now,
      ],
    );
  }

  #newId(field: string): Buffer {
    const value = this.#idFactory();
    if (!Buffer.isBuffer(value) || value.byteLength !== 16) {
      throw new AssistantLifecyclePersistenceError(`${field} factory is invalid`);
    }
    return Buffer.from(value);
  }

  #newSlug(): string {
    const value = this.#slugFactory();
    if (value !== value.toLowerCase() || !/^[a-z0-9-]{1,63}$/u.test(value)) {
      throw new AssistantLifecyclePersistenceError('public slug factory is invalid');
    }
    return value;
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

  async #withTransaction<TResult>(
    operation: (connection: Connection) => Promise<TResult>,
  ): Promise<TResult> {
    return this.#withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }
}
