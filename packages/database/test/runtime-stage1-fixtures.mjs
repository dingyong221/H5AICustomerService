import { randomBytes } from 'node:crypto';
import {
  loadDatabaseConfig, MySqlAssistantLifecycleRepository, MySqlPublicSessionRepository,
} from '../dist/index.js';

const url = process.env.H5CS_INTEGRATION_MYSQL_URL;
if (!url) throw new Error('Dedicated loopback integration target required');
const target = new URL(url);
if (target.protocol !== 'mysql:' || !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.username !== 'h5cs_ci' || target.pathname !== '/h5cs_integration_ci' || target.search || target.hash)
  throw new Error('Refusing non-CI integration target');
const loaded = loadDatabaseConfig({ MYSQL_DATABASE_URL: url, NODE_ENV: 'test', APP_ENV: 'test' });
if (!loaded.configured) throw new Error('Dedicated test configuration unavailable');
export const database = loaded.config;
export const lifecycle = new MySqlAssistantLifecycleRepository(database);
export const publicSessionSigningSecret = randomBytes(32).toString('base64url');
export const publicSessions = new MySqlPublicSessionRepository(database, publicSessionSigningSecret);
export const freshId = () => randomBytes(16).toString('hex');
export async function sql(statement, parameters = []) {
  const connection = await database.openConnection();
  try { return (await connection.execute(statement, parameters))[0]; }
  finally { await connection.end(); }
}
const idempotency = () => ({ actorScopeDigest: randomBytes(32), keyDigest: randomBytes(32), requestHash: randomBytes(32), expiresAt: new Date(Date.now() + 3600000) });
const draft = {
  industry: '本地合成服务', businessScope: '仅供运行契约测试', materialsSummary: '挂机清洗79元/台',
  pricingSummary: '挂机清洗79元/台', promotionSummary: '暂无优惠', welcomeMessage: '你好，我是合成 AI 客服。',
  insufficientInfoMessage: '资料不足，请联系合成测试商家。', humanContact: '合成测试联络说明',
};
export async function seed() {
  const merchantId = freshId(), merchantUserId = freshId();
  await sql(`INSERT INTO merchant(id,name,status) VALUES(UNHEX(?),'运行契约合成商家','active')`, [merchantId]);
  await sql(`INSERT INTO merchant_user(id,status) VALUES(UNHEX(?),'active')`, [merchantUserId]);
  await sql(`INSERT INTO merchant_membership(merchant_id,merchant_user_id,role,status) VALUES(UNHEX(?),UNHEX(?),'owner','active')`, [merchantId, merchantUserId]);
  const created = await lifecycle.createManualDraft({ merchantId, merchantUserId, displayName: '运行契约合成客服', draft, idempotency: idempotency(), now: new Date() });
  const scope = { merchantId, merchantUserId, assistantId: created.assistantId };
  await lifecycle.confirmDraftKnowledge({ ...scope, expectedDraftRevision: 1, now: new Date() });
  const check = await lifecycle.savePreviewCheck({ ...scope, expectedDraftRevision: 1, question: '合成价格', answer: '挂机清洗79元/台', now: new Date() });
  await lifecycle.judgePreviewCheck({ ...scope, expectedDraftRevision: 1, checkId: check.checkId, verdict: 'pass', now: new Date() });
  const released = await lifecycle.publish({ ...scope, expectedDraftRevision: 1, promptTemplateVersion: 'conversation-v1', retrievalPolicyVersion: 'confirmed-text-v1', modelPolicyVersion: 'local-no-model-v1', idempotency: idempotency(), now: new Date() });
  return { ...scope, publicSlug: created.publicSlug, releaseId: released.releaseId };
}
export async function turn(scope, { legacy = false } = {}) {
  const visitorNonce = randomBytes(32).toString('base64url');
  const session = await publicSessions.createSession({ publicSlug: scope.publicSlug, sessionRequestId: `session_request_${freshId()}`, visitorNonce, now: new Date() });
  const accepted = await publicSessions.acceptTurn({ sessionHandle: session.sessionHandle, visitorNonce, clientMessageId: `message_${freshId()}`, content: '清洗多少钱？', now: new Date() });
  const [job] = await sql(`SELECT LOWER(HEX(id)) id, payload FROM job WHERE merchant_id=UNHEX(?) AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.turnId'))=?`, [scope.merchantId, accepted.turnId]);
  if (legacy) await sql(`UPDATE job SET payload=JSON_REMOVE(payload,'$.schemaVersion','$.handlerVersion') WHERE id=UNHEX(?)`, [job.id]);
  return { ...accepted, ...session, visitorNonce, jobId: job.id };
}
export async function entitlement(scope, limit = 1) {
  const subject = randomBytes(32), product = 'h5ai-self-service-v1';
  await sql(`INSERT INTO marketplace_free_claim(subject_digest,product,claim_id,source,price_version,created_at) VALUES(?,?,?,'local-fixture','free-local-v1',UTC_TIMESTAMP(6))`, [subject, product, randomBytes(16)]);
  await sql(`INSERT INTO marketplace_entitlement(subject_digest,product,status,version,valid_from,model_call_limit) VALUES(?,?,'active',1,DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 MINUTE),?)`, [subject, product, limit]);
  await sql(`INSERT INTO marketplace_allocation(subject_digest,product,merchant_user_id,merchant_id,assistant_id,created_at) VALUES(?,?,UNHEX(?),UNHEX(?),UNHEX(?),UTC_TIMESTAMP(6))`, [subject, product, scope.merchantUserId, scope.merchantId, scope.assistantId]);
  return subject;
}
