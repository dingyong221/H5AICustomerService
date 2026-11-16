import { randomBytes, createHash } from 'node:crypto';
import {
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlKnowledgeMaterialRepository,
  MySqlKnowledgeOrganizationRepository,
  MySqlModelCallAttemptRepository,
  MySqlPublicSessionRepository,
} from '../dist/index.js';
const url = process.env.H5CS_STAGE2_MYSQL_URL;
if (!url) throw Error('Dedicated stage2 target required');
const u = new URL(url);
if (
  u.protocol !== 'mysql:' ||
  u.hostname !== '127.0.0.1' ||
  u.username !== 'h5cs_stage2' ||
  u.pathname !== '/h5cs_stage2_ci' ||
  u.search ||
  u.hash
)
  throw Error('Refusing non-stage2 database');
const loaded = loadDatabaseConfig({ MYSQL_DATABASE_URL: url, NODE_ENV: 'test', APP_ENV: 'test' });
if (!loaded.configured) throw Error('Dedicated database unavailable');
export const database = loaded.config,
  lifecycle = new MySqlAssistantLifecycleRepository(database),
  materials = new MySqlKnowledgeMaterialRepository(database),
  jobs = new MySqlKnowledgeOrganizationRepository(database, true),
  attempts = new MySqlModelCallAttemptRepository(database);
export const fresh = () => randomBytes(16).toString('hex');
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export async function entitlement(scope) {
  const subject = randomBytes(32),
    product = 'h5ai-self-service-v1';
  await sql(
    "INSERT INTO marketplace_free_claim(subject_digest,product,claim_id,source,price_version,created_at) VALUES(?,?,?,'local-fixture','free-local-v1',UTC_TIMESTAMP(6))",
    [subject, product, randomBytes(16)],
  );
  await sql(
    "INSERT INTO marketplace_entitlement(subject_digest,product,status,version,valid_from,model_call_limit) VALUES(?,?,'active',1,DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 MINUTE),1)",
    [subject, product],
  );
  await sql(
    'INSERT INTO marketplace_allocation(subject_digest,product,merchant_user_id,merchant_id,assistant_id,created_at) VALUES(?,?,UNHEX(?),UNHEX(?),UNHEX(?),UTC_TIMESTAMP(6))',
    [subject, product, scope.userId, scope.merchantId, scope.assistantId],
  );
  return subject;
}
export const signingSecret = randomBytes(32).toString('base64url');
export const publicSessions = new MySqlPublicSessionRepository(database, signingSecret);
export const draft = {
  industry: '阶段2合成零售',
  businessScope: '仅用于软件验收，不交易',
  materialsSummary: '毛巾29元/条，运费需确认。',
  pricingSummary: '毛巾29元/条，运费需确认。',
  promotionSummary: '没有优惠',
  welcomeMessage: '您好，我是合成AI客服',
  insufficientInfoMessage: '资料不足，请人工确认',
  humanContact: '合成测试负责人',
};
const idem = () => ({
  actorScopeDigest: randomBytes(32),
  keyDigest: randomBytes(32),
  requestHash: randomBytes(32),
  expiresAt: new Date(Date.now() + 3600000),
});
export async function sql(statement, params = []) {
  const c = await database.openConnection();
  try {
    return (await c.execute(statement, params))[0];
  } finally {
    await c.end();
  }
}
export async function seed() {
  const merchantId = fresh(),
    userId = fresh();
  await sql("INSERT INTO merchant(id,name,status) VALUES(UNHEX(?),'阶段2合成商家','active')", [
    merchantId,
  ]);
  await sql("INSERT INTO merchant_user(id,status) VALUES(UNHEX(?),'active')", [userId]);
  await sql(
    "INSERT INTO merchant_membership(merchant_id,merchant_user_id,role,status) VALUES(UNHEX(?),UNHEX(?),'owner','active')",
    [merchantId, userId],
  );
  const created = await lifecycle.createManualDraft({
    merchantId,
    merchantUserId: userId,
    displayName: '阶段2合成客服',
    draft,
    idempotency: idem(),
    now: new Date(),
  });
  const scope = { merchantId, userId, merchantUserId: userId, assistantId: created.assistantId };
  await lifecycle.confirmDraftKnowledge({ ...scope, expectedDraftRevision: 1, now: new Date() });
  const check = await lifecycle.savePreviewCheck({
    ...scope,
    expectedPreviousPreviewId: null,
    expectedDraftRevision: 1,
    question: '合成夹具价格',
    answer: '毛巾29元，运费需确认',
    now: new Date(),
  });
  await lifecycle.judgePreviewCheck({
    ...scope,
    expectedDraftRevision: 1,
    checkId: check.checkId,
    verdict: 'pass',
    now: new Date(),
  });
  const release = await lifecycle.publish({
    ...scope,
    expectedDraftRevision: 1,
    promptTemplateVersion: 'conversation-v1',
    retrievalPolicyVersion: 'confirmed-text-v1',
    modelPolicyVersion: 'local-no-model-v1',
    idempotency: idem(),
    now: new Date(),
  });
  const text = '毛巾29元/条，运费需确认。';
  const sourceId = await materials.save({
    ...scope,
    name: '阶段2合成材料.txt',
    size: Buffer.byteLength(text),
    // File bytes differ from extracted text; the old uploader stores this in
    // source_metadata.sha256 but hashes input.text for revision.content_hash.
    sha256: hash('synthetic-file-container:' + text),
    text,
  });
  return { ...scope, sourceId, publicSlug: created.publicSlug, releaseId: release.releaseId };
}
export const request = (scope, extras = {}) => ({
  ...scope,
  requestId: 'organize_' + fresh(),
  revision: 1,
  sourceIds: [scope.sourceId],
  consent: true,
  now: new Date(),
  ...extras,
});
export async function accepted(scope, extras = {}) {
  return jobs.enqueue(request(scope, extras));
}
export const claim = (scope) =>
  jobs.claimNext(new Date(), 'stage2_test_worker', { merchantId: scope.merchantId });
export const expire = (c) =>
  sql('UPDATE job SET lease_until=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE id=UNHEX(?)', [
    c.jobId,
  ]);
export async function complete(scope) {
  const task = await accepted(scope),
    c = await claim(scope);
  const r = await attempts.markDispatch(
    { merchantId: scope.merchantId, operation: 'organize', knowledgeClaim: c },
    new Date(),
  );
  await attempts.recordOutcome(r.attemptId, 'succeeded', new Date(), 'synthetic-' + fresh());
  await jobs.complete(
    c,
    { summary: '毛巾29元/条，运费需确认。', warnings: ['请核对原文'] },
    new Date(),
  );
  return { task, claim: c, receipt: r };
}
export const apply = (scope, task, extras = {}) =>
  lifecycle.applyKnowledgeOrganization({
    ...scope,
    taskId: task.taskId,
    expectedRevision: 1,
    summary: '毛巾29元/条，运费需确认。',
    mode: 'replace',
    confirmed: true,
    now: new Date(),
    ...extras,
  });
