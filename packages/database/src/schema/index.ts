import { sql } from 'drizzle-orm';
import {
  binary,
  datetime,
  foreignKey,
  index,
  int,
  json,
  mediumtext,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const id = (name: string) => binary(name, { length: 16 });
const digest = (name: string) => binary(name, { length: 32 });
const utcDateTime = (name: string) => datetime(name, { fsp: 6, mode: 'date' });
const createdAt = () =>
  utcDateTime('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(6)`);
const updatedAt = () =>
  utcDateTime('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(6)`)
    .$onUpdateFn(() => sql`CURRENT_TIMESTAMP(6)`);

export const merchants = mysqlTable(
  'merchant',
  {
    id: id('id').notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Shanghai'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_merchant' }),
    uniqueIndex('uq_merchant_scope').on(table.id),
    index('idx_merchant_status').on(table.status, table.id),
  ],
);

export const merchantUsers = mysqlTable(
  'merchant_user',
  {
    id: id('id').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_merchant_user' }),
    index('idx_merchant_user_status').on(table.status, table.id),
  ],
);

export const externalIdentities = mysqlTable(
  'external_identity',
  {
    id: id('id').notNull(),
    merchantUserId: id('merchant_user_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    issuer: varchar('issuer', { length: 255 }).notNull(),
    audience: varchar('audience', { length: 191 }).notNull(),
    subjectLookupKey: digest('subject_lookup_key').notNull(),
    subjectLookupKeyVersion: int('subject_lookup_key_version', { unsigned: true }).notNull(),
    phoneMatchVerifiedAt: utcDateTime('phone_match_verified_at'),
    lastSeenAt: utcDateTime('last_seen_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_external_identity' }),
    uniqueIndex('uq_external_identity_subject').on(
      table.provider,
      table.issuer,
      table.audience,
      table.subjectLookupKey,
    ),
    index('idx_external_identity_user').on(table.merchantUserId, table.id),
    foreignKey({
      columns: [table.merchantUserId],
      foreignColumns: [merchantUsers.id],
      name: 'fk_external_identity_merchant_user',
    }).onDelete('restrict'),
  ],
);

export const merchantMemberships = mysqlTable(
  'merchant_membership',
  {
    merchantId: id('merchant_id').notNull(),
    merchantUserId: id('merchant_user_id').notNull(),
    role: varchar('role', { length: 32 }).notNull().default('owner'),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.merchantId, table.merchantUserId],
      name: 'pk_merchant_membership',
    }),
    index('idx_merchant_membership_user').on(table.merchantUserId, table.status, table.merchantId),
    foreignKey({
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
      name: 'fk_merchant_membership_merchant',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.merchantUserId],
      foreignColumns: [merchantUsers.id],
      name: 'fk_merchant_membership_user',
    }).onDelete('restrict'),
  ],
);

export const oauthPublicClients = mysqlTable(
  'oauth_public_client',
  {
    clientIdDigest: digest('client_id_digest').notNull(),
    clientId: varchar('client_id', { length: 128 }).notNull(),
    clientName: varchar('client_name', { length: 200 }),
    redirectUris: json('redirect_uris').$type<readonly string[]>().notNull(),
    createdAt: utcDateTime('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientIdDigest], name: 'pk_oauth_public_client' }),
    index('idx_oauth_public_client_created').on(table.createdAt, table.clientIdDigest),
  ],
);

export const oauthAuthorizationCodes = mysqlTable(
  'oauth_authorization_code',
  {
    codeDigest: digest('code_digest').notNull(),
    clientIdDigest: digest('client_id_digest').notNull(),
    redirectUri: varchar('redirect_uri', { length: 2048 }).notNull(),
    resource: varchar('resource', { length: 2048 }).notNull(),
    scope: varchar('scope', { length: 64 }).notNull(),
    codeChallenge: varchar('code_challenge', { length: 128 }).notNull(),
    bindingId: varchar('binding_id', { length: 191 }).notNull(),
    expiresAt: utcDateTime('expires_at').notNull(),
    consumedAt: utcDateTime('consumed_at'),
    createdAt: utcDateTime('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.codeDigest], name: 'pk_oauth_authorization_code' }),
    index('idx_oauth_authorization_code_expiry').on(
      table.consumedAt,
      table.expiresAt,
      table.codeDigest,
    ),
    foreignKey({
      columns: [table.clientIdDigest],
      foreignColumns: [oauthPublicClients.clientIdDigest],
      name: 'fk_oauth_authorization_code_client',
    }).onDelete('restrict'),
  ],
);

export const oauthRefreshTokenFamilies = mysqlTable(
  'oauth_refresh_token_family',
  {
    familyIdDigest: digest('family_id_digest').notNull(),
    familyId: varchar('family_id', { length: 128 }).notNull(),
    clientIdDigest: digest('client_id_digest').notNull(),
    bindingId: varchar('binding_id', { length: 191 }).notNull(),
    resource: varchar('resource', { length: 2048 }).notNull(),
    scope: varchar('scope', { length: 64 }).notNull(),
    revokedAt: utcDateTime('revoked_at'),
    createdAt: utcDateTime('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.familyIdDigest], name: 'pk_oauth_refresh_token_family' }),
    index('idx_oauth_refresh_family_client').on(table.clientIdDigest, table.createdAt),
    index('idx_oauth_refresh_family_revoked').on(table.revokedAt, table.familyIdDigest),
    foreignKey({
      columns: [table.clientIdDigest],
      foreignColumns: [oauthPublicClients.clientIdDigest],
      name: 'fk_oauth_refresh_family_client',
    }).onDelete('restrict'),
  ],
);

export const oauthRefreshTokens = mysqlTable(
  'oauth_refresh_token',
  {
    tokenDigest: digest('token_digest').notNull(),
    familyIdDigest: digest('family_id_digest').notNull(),
    replacementTokenDigest: digest('replacement_token_digest'),
    expiresAt: utcDateTime('expires_at').notNull(),
    usedAt: utcDateTime('used_at'),
    createdAt: utcDateTime('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenDigest], name: 'pk_oauth_refresh_token' }),
    index('idx_oauth_refresh_token_family').on(table.familyIdDigest, table.createdAt),
    index('idx_oauth_refresh_token_expiry').on(table.usedAt, table.expiresAt, table.tokenDigest),
    foreignKey({
      columns: [table.familyIdDigest],
      foreignColumns: [oauthRefreshTokenFamilies.familyIdDigest],
      name: 'fk_oauth_refresh_token_family',
    }).onDelete('restrict'),
  ],
);

export const industryTemplates = mysqlTable(
  'industry_template',
  {
    id: id('id').notNull(),
    code: varchar('code', { length: 64 }).notNull(),
    version: int('version', { unsigned: true }).notNull(),
    displayName: varchar('display_name', { length: 128 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    requiredMaterials: json('required_materials').$type<readonly string[]>().notNull(),
    requiredPolicies: json('required_policies').$type<readonly string[]>().notNull(),
    template: json('template').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_industry_template' }),
    uniqueIndex('uq_industry_template_code_version').on(table.code, table.version),
    index('idx_industry_template_status').on(table.status, table.code, table.version),
  ],
);

export const assistants = mysqlTable(
  'assistant',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id').notNull(),
    publicSlug: varchar('public_slug', { length: 128 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('draft_only'),
    activeReleaseId: id('active_release_id'),
    draftRevision: int('draft_revision', { unsigned: true }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_assistant' }),
    uniqueIndex('uq_assistant_scope').on(table.merchantId, table.id),
    uniqueIndex('uq_assistant_public_slug').on(table.publicSlug),
    index('idx_assistant_merchant_status').on(table.merchantId, table.status, table.id),
    foreignKey({
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
      name: 'fk_assistant_merchant',
    }).onDelete('restrict'),
  ],
);

export const onboardingSessions = mysqlTable(
  'onboarding_session',
  {
    id: id('id').notNull(),
    merchantUserId: id('merchant_user_id').notNull(),
    merchantId: id('merchant_id'),
    assistantId: id('assistant_id'),
    industryTemplateId: id('industry_template_id'),
    state: varchar('state', { length: 32 }).notNull(),
    cancelledFromState: varchar('cancelled_from_state', { length: 32 }),
    answers: json('answers').$type<Record<string, unknown>>().notNull(),
    missingItems: json('missing_items').$type<readonly Record<string, unknown>[]>().notNull(),
    generationErrorCode: varchar('generation_error_code', { length: 64 }),
    version: int('version', { unsigned: true }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    cancelledAt: utcDateTime('cancelled_at'),
    completedAt: utcDateTime('completed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_onboarding_session' }),
    index('idx_onboarding_user_updated').on(table.merchantUserId, table.updatedAt, table.id),
    index('idx_onboarding_state').on(table.state, table.updatedAt, table.id),
    foreignKey({
      columns: [table.merchantUserId],
      foreignColumns: [merchantUsers.id],
      name: 'fk_onboarding_session_user',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.merchantId],
      foreignColumns: [merchants.id],
      name: 'fk_onboarding_session_merchant',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.industryTemplateId],
      foreignColumns: [industryTemplates.id],
      name: 'fk_onboarding_session_industry_template',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.merchantId, table.assistantId],
      foreignColumns: [assistants.merchantId, assistants.id],
      name: 'fk_onboarding_session_assistant',
    }).onDelete('restrict'),
  ],
);

export const assistantDrafts = mysqlTable(
  'assistant_draft',
  {
    assistantId: id('assistant_id').notNull(),
    merchantId: id('merchant_id').notNull(),
    revision: int('revision', { unsigned: true }).notNull(),
    config: json('config').$type<Record<string, unknown>>().notNull(),
    validation: json('validation').$type<Record<string, unknown>>().notNull(),
    updatedBy: id('updated_by'),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.assistantId], name: 'pk_assistant_draft' }),
    uniqueIndex('uq_assistant_draft_scope').on(table.merchantId, table.assistantId),
    foreignKey({
      columns: [table.merchantId, table.assistantId],
      foreignColumns: [assistants.merchantId, assistants.id],
      name: 'fk_assistant_draft_assistant',
    }).onDelete('cascade'),
  ],
);

export const releases = mysqlTable(
  'assistant_release',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id').notNull(),
    assistantId: id('assistant_id').notNull(),
    releaseNo: int('release_no', { unsigned: true }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    configSnapshot: json('config_snapshot').$type<Record<string, unknown>>().notNull(),
    promptTemplateVersion: varchar('prompt_template_version', { length: 64 }).notNull(),
    retrievalPolicyVersion: varchar('retrieval_policy_version', { length: 64 }).notNull(),
    modelPolicyVersion: varchar('model_policy_version', { length: 64 }).notNull(),
    createdBy: id('created_by'),
    createdAt: createdAt(),
    activatedAt: utcDateTime('activated_at'),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_assistant_release' }),
    uniqueIndex('uq_release_scope').on(table.merchantId, table.assistantId, table.id),
    uniqueIndex('uq_release_number').on(table.merchantId, table.assistantId, table.releaseNo),
    index('idx_release_status').on(table.merchantId, table.assistantId, table.status, table.id),
    foreignKey({
      columns: [table.merchantId, table.assistantId],
      foreignColumns: [assistants.merchantId, assistants.id],
      name: 'fk_release_assistant',
    }).onDelete('restrict'),
  ],
);

export const knowledgeSources = mysqlTable(
  'knowledge_source',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id').notNull(),
    assistantId: id('assistant_id').notNull(),
    type: varchar('type', { length: 32 }).notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    currentRevisionNo: int('current_revision_no', { unsigned: true }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_knowledge_source' }),
    uniqueIndex('uq_knowledge_source_scope').on(table.merchantId, table.assistantId, table.id),
    index('idx_knowledge_source_status').on(
      table.merchantId,
      table.assistantId,
      table.status,
      table.id,
    ),
    foreignKey({
      columns: [table.merchantId, table.assistantId],
      foreignColumns: [assistants.merchantId, assistants.id],
      name: 'fk_knowledge_source_assistant',
    }).onDelete('restrict'),
  ],
);

export const knowledgeRevisions = mysqlTable(
  'knowledge_revision',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id').notNull(),
    assistantId: id('assistant_id').notNull(),
    sourceId: id('source_id').notNull(),
    revisionNo: int('revision_no', { unsigned: true }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    contentHash: digest('content_hash').notNull(),
    sourceMetadata: json('source_metadata').$type<Record<string, unknown>>().notNull(),
    objectKey: varchar('object_key', { length: 1024 }),
    parserVersion: varchar('parser_version', { length: 64 }),
    embeddingModel: varchar('embedding_model', { length: 128 }),
    embeddingVersion: varchar('embedding_version', { length: 64 }),
    derivedIndexRef: varchar('derived_index_ref', { length: 512 }),
    failureCode: varchar('failure_code', { length: 64 }),
    effectiveFrom: utcDateTime('effective_from'),
    effectiveUntil: utcDateTime('effective_until'),
    createdAt: createdAt(),
    processedAt: utcDateTime('processed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_knowledge_revision' }),
    uniqueIndex('uq_knowledge_revision_scope').on(table.merchantId, table.assistantId, table.id),
    uniqueIndex('uq_knowledge_revision_number').on(
      table.merchantId,
      table.assistantId,
      table.sourceId,
      table.revisionNo,
    ),
    index('idx_knowledge_revision_status').on(
      table.merchantId,
      table.assistantId,
      table.status,
      table.id,
    ),
    foreignKey({
      columns: [table.merchantId, table.assistantId, table.sourceId],
      foreignColumns: [
        knowledgeSources.merchantId,
        knowledgeSources.assistantId,
        knowledgeSources.id,
      ],
      name: 'fk_knowledge_revision_source',
    }).onDelete('restrict'),
  ],
);

export const sessions = mysqlTable(
  'conversation_session',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id').notNull(),
    assistantId: id('assistant_id').notNull(),
    releaseId: id('release_id').notNull(),
    visitorCredentialId: id('visitor_credential_id').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    nextSequence: int('next_sequence', { unsigned: true }).notNull().default(1),
    activeTurnId: id('active_turn_id'),
    version: int('version', { unsigned: true }).notNull().default(1),
    lastActivityAt: utcDateTime('last_activity_at').notNull(),
    expiresAt: utcDateTime('expires_at').notNull(),
    endedAt: utcDateTime('ended_at'),
    endedReason: varchar('ended_reason', { length: 64 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_conversation_session' }),
    uniqueIndex('uq_session_scope').on(table.merchantId, table.assistantId, table.id),
    index('idx_session_resume').on(
      table.merchantId,
      table.assistantId,
      table.visitorCredentialId,
      table.status,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.merchantId, table.assistantId],
      foreignColumns: [assistants.merchantId, assistants.id],
      name: 'fk_session_assistant',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.merchantId, table.assistantId, table.releaseId],
      foreignColumns: [releases.merchantId, releases.assistantId, releases.id],
      name: 'fk_session_release',
    }).onDelete('restrict'),
  ],
);

export const messages = mysqlTable(
  'message',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id').notNull(),
    assistantId: id('assistant_id').notNull(),
    sessionId: id('session_id').notNull(),
    turnId: id('turn_id').notNull(),
    seqNo: int('seq_no', { unsigned: true }).notNull(),
    role: varchar('role', { length: 24 }).notNull(),
    state: varchar('state', { length: 32 }).notNull(),
    clientRequestId: varchar('client_request_id', { length: 128 }),
    content: mediumtext('content').notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    createdAt: createdAt(),
    completedAt: utcDateTime('completed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_message' }),
    uniqueIndex('uq_message_scope').on(table.merchantId, table.assistantId, table.id),
    uniqueIndex('uq_message_sequence').on(table.sessionId, table.seqNo),
    uniqueIndex('uq_message_client_request').on(table.sessionId, table.clientRequestId),
    index('idx_message_session_created').on(table.sessionId, table.createdAt, table.id),
    foreignKey({
      columns: [table.merchantId, table.assistantId, table.sessionId],
      foreignColumns: [sessions.merchantId, sessions.assistantId, sessions.id],
      name: 'fk_message_session',
    }).onDelete('cascade'),
  ],
);

export const idempotencyRecords = mysqlTable(
  'idempotency_record',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id'),
    actorScopeDigest: digest('actor_scope_digest').notNull(),
    operation: varchar('operation', { length: 128 }).notNull(),
    keyDigest: digest('key_digest').notNull(),
    requestHash: digest('request_hash').notNull(),
    state: varchar('state', { length: 32 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }),
    resourceId: id('resource_id'),
    responseCode: int('response_code', { unsigned: true }),
    responseBody: json('response_body').$type<Record<string, unknown>>(),
    expiresAt: utcDateTime('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_idempotency_record' }),
    uniqueIndex('uq_idempotency_scope_key').on(
      table.actorScopeDigest,
      table.operation,
      table.keyDigest,
    ),
    index('idx_idempotency_expiry').on(table.expiresAt, table.id),
    index('idx_idempotency_merchant').on(table.merchantId, table.createdAt, table.id),
  ],
);

export const outboxEvents = mysqlTable(
  'outbox_event',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id'),
    eventType: varchar('event_type', { length: 128 }).notNull(),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: id('aggregate_id').notNull(),
    schemaVersion: int('schema_version', { unsigned: true }).notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    state: varchar('state', { length: 32 }).notNull().default('pending'),
    attempt: int('attempt', { unsigned: true }).notNull().default(0),
    availableAt: utcDateTime('available_at').notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseUntil: utcDateTime('lease_until'),
    occurredAt: utcDateTime('occurred_at').notNull(),
    publishedAt: utcDateTime('published_at'),
    traceId: varchar('trace_id', { length: 128 }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_outbox_event' }),
    index('idx_outbox_claim').on(table.state, table.availableAt, table.leaseUntil, table.id),
    index('idx_outbox_aggregate').on(table.aggregateType, table.aggregateId, table.id),
  ],
);

export const jobs = mysqlTable(
  'job',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id'),
    type: varchar('type', { length: 128 }).notNull(),
    dedupKey: digest('dedup_key').notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    state: varchar('state', { length: 32 }).notNull().default('pending'),
    priority: int('priority').notNull().default(0),
    attempt: int('attempt', { unsigned: true }).notNull().default(0),
    maxAttempts: int('max_attempts', { unsigned: true }).notNull().default(5),
    runAfter: utcDateTime('run_after').notNull(),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseUntil: utcDateTime('lease_until'),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: utcDateTime('completed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_job' }),
    uniqueIndex('uq_job_type_dedup').on(table.type, table.dedupKey),
    index('idx_job_claim').on(table.state, table.runAfter, table.priority, table.id),
    index('idx_job_lease_recovery').on(table.state, table.leaseUntil, table.id),
    index('idx_job_merchant').on(table.merchantId, table.createdAt, table.id),
  ],
);

export const auditLogs = mysqlTable(
  'audit_log',
  {
    id: id('id').notNull(),
    merchantId: id('merchant_id'),
    actorType: varchar('actor_type', { length: 32 }).notNull(),
    actorId: varchar('actor_id', { length: 128 }).notNull(),
    action: varchar('action', { length: 128 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: varchar('target_id', { length: 128 }).notNull(),
    result: varchar('result', { length: 32 }).notNull(),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 512 }),
    metadata: json('metadata').$type<Record<string, unknown>>(),
    occurredAt: utcDateTime('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: 'pk_audit_log' }),
    index('idx_audit_merchant_time').on(table.merchantId, table.occurredAt, table.id),
    index('idx_audit_request').on(table.requestId, table.id),
    index('idx_audit_target').on(table.targetType, table.targetId, table.occurredAt),
  ],
);

export type MerchantRow = typeof merchants.$inferSelect;
export type AssistantRow = typeof assistants.$inferSelect;
export type ReleaseRow = typeof releases.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type MerchantUserRow = typeof merchantUsers.$inferSelect;
export type OnboardingSessionRow = typeof onboardingSessions.$inferSelect;
