import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlPublicSessionRepository,
  MySqlConversationTurnJobRepository,
  PublicReleaseWithdrawnError,
} from '../dist/index.js';

const url = process.env.H5CS_INTEGRATION_MYSQL_URL;
if (!url) throw new Error('A dedicated integration target is required');
const target = new URL(url);
if (
  target.protocol !== 'mysql:' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.username !== 'h5cs_ci' ||
  target.pathname !== '/h5cs_integration_ci' ||
  target.search ||
  target.hash
)
  throw new Error('Governance tests require the dedicated loopback CI target');
const loaded = loadDatabaseConfig({ MYSQL_DATABASE_URL: url, NODE_ENV: 'test', APP_ENV: 'test' });
if (!loaded.configured) throw new Error('Dedicated test configuration is unavailable');
const database = loaded.config;
const repository = new MySqlAssistantLifecycleRepository(database);
const freshId = () => randomBytes(16).toString('hex');
const idempotency = () => ({
  actorScopeDigest: randomBytes(32),
  keyDigest: randomBytes(32),
  requestHash: randomBytes(32),
  expiresAt: new Date(Date.now() + 3600000),
});
const draft = {
  industry: '本地合成服务',
  businessScope: '仅供治理测试的清洗咨询',
  materialsSummary: '清洗：79元/台，仅限壁挂机',
  pricingSummary: '清洗：79元/台，仅限壁挂机',
  promotionSummary: '暂无优惠',
  welcomeMessage: '你好，我是合成 AI 客服。',
  insufficientInfoMessage: '资料不足，请联系合成测试商家。',
  humanContact: '合成测试联络说明，不是真实渠道',
};
async function sql(statement, parameters = []) {
  const c = await database.openConnection();
  try {
    return (await c.execute(statement, parameters))[0];
  } finally {
    await c.end();
  }
}
async function seed() {
  const merchantId = freshId(),
    merchantUserId = freshId();
  await sql(`INSERT INTO merchant(id,name,status) VALUES (UNHEX(?),'治理合成商家','active')`, [
    merchantId,
  ]);
  await sql(`INSERT INTO merchant_user(id,status) VALUES(UNHEX(?),'active')`, [merchantUserId]);
  await sql(
    `INSERT INTO merchant_membership(merchant_id,merchant_user_id,role,status) VALUES(UNHEX(?),UNHEX(?),'owner','active')`,
    [merchantId, merchantUserId],
  );
  const created = await repository.createManualDraft({
    merchantId,
    merchantUserId,
    displayName: '治理合成客服',
    draft,
    idempotency: idempotency(),
    now: new Date(),
  });
  return {
    merchantId,
    merchantUserId,
    assistantId: created.assistantId,
    publicSlug: created.publicSlug,
  };
}
const governed = async (scope) =>
  repository.getPublicationGovernance({ ...scope, now: new Date() });
async function pass(scope, revision = 1) {
  const check = await repository.savePreviewCheck({
    ...scope,
    expectedDraftRevision: revision,
    question: '清洗价格及适用条件是什么？',
    answer: '合成试聊回答：79元/台，仅限壁挂机。',
    now: new Date(),
  });
  await repository.judgePreviewCheck({
    ...scope,
    expectedDraftRevision: revision,
    checkId: check.checkId,
    verdict: 'pass',
    now: new Date(),
  });
  return check;
}
async function publish(scope, revision = 1) {
  await repository.confirmDraftKnowledge({
    ...scope,
    expectedDraftRevision: revision,
    now: new Date(),
  });
  return repository.publish({
    ...scope,
    expectedDraftRevision: revision,
    promptTemplateVersion: 'governance-test-v1',
    retrievalPolicyVersion: 'confirmed-test-v1',
    modelPolicyVersion: 'local-fixture-only',
    idempotency: idempotency(),
    now: new Date(),
  });
}
const code = (expected) => (error) => error?.code === expected;

test('real MySQL: publishing needs a successful same-revision preview and explicit passing judgment', async () => {
  const scope = await seed();
  await assert.rejects(() => publish(scope), code('PREVIEW_REQUIRED'));
  const check = await repository.savePreviewCheck({
    ...scope,
    expectedDraftRevision: 1,
    question: '合成问题',
    answer: '合成回答',
    now: new Date(),
  });
  assert.equal((await governed(scope)).quality.state, 'needs_review');
  await assert.rejects(() => publish(scope), code('PREVIEW_REQUIRED'));
  await repository.judgePreviewCheck({
    ...scope,
    expectedDraftRevision: 1,
    checkId: check.checkId,
    verdict: 'fail',
    now: new Date(),
  });
  await assert.rejects(() => publish(scope), code('PREVIEW_REQUIRED'));
  await pass(scope);
  const release = await publish(scope);
  assert.equal(release.releaseNo, 1);
  assert.equal((await governed(scope)).hasUnpublishedChanges, false);
  const saved = await repository.saveDraft({
    ...scope,
    expectedRevision: 1,
    draft: { ...draft, businessScope: '更新的合成服务范围' },
    now: new Date(),
  });
  assert.equal(saved.draftRevision, 2);
  assert.equal((await governed(scope)).quality.state, 'not_tested');
  assert.equal((await governed(scope)).hasUnpublishedChanges, true);
  await assert.rejects(() => publish(scope, 2), code('PREVIEW_REQUIRED'));
});

test('real MySQL: exact same-condition conflicts and explicit past expiry block publication, unlike different conditions', async () => {
  const scope = await seed();
  await repository.saveDraft({
    ...scope,
    expectedRevision: 1,
    draft: { ...draft, pricingSummary: '清洗：89元/台，仅限壁挂机' },
    now: new Date(),
  });
  await pass(scope, 2);
  await assert.rejects(() => publish(scope, 2), code('FACTS_BLOCKED'));
  await repository.saveDraft({
    ...scope,
    expectedRevision: 2,
    draft: { ...draft, pricingSummary: '清洗：99元/台，仅限柜机' },
    now: new Date(),
  });
  await pass(scope, 3);
  assert.equal((await publish(scope, 3)).releaseNo, 1);
  await repository.saveDraft({
    ...scope,
    expectedRevision: 3,
    draft: { ...draft, promotionSummary: '活动有效期至2000-01-01' },
    now: new Date(),
  });
  await pass(scope, 4);
  await assert.rejects(() => publish(scope, 4), code('FACTS_BLOCKED'));
});

test('real MySQL: rename increments revision, keeps the slug and published immutable name until retested release', async () => {
  const scope = await seed();
  await pass(scope);
  await publish(scope);
  const before = await repository.findPublicSnapshot(scope.publicSlug);
  const renamed = await repository.renameAssistant({
    ...scope,
    expectedRevision: 1,
    displayName: '新的合成客服',
    now: new Date(),
  });
  assert.equal(renamed.publicSlug, scope.publicSlug);
  assert.equal(renamed.draftRevision, 2);
  assert.equal(renamed.draft.welcomeMessage, draft.welcomeMessage);
  assert.equal(
    (await repository.findPublicSnapshot(scope.publicSlug)).assistantName,
    before.assistantName,
  );
  await assert.rejects(() => publish(scope, 2), code('PREVIEW_REQUIRED'));
  await pass(scope, 2);
  await publish(scope, 2);
  assert.equal(
    (await repository.findPublicSnapshot(scope.publicSlug)).assistantName,
    '新的合成客服',
  );
  assert.equal((await repository.listReleaseHistory({ ...scope })).items.length, 2);
});

test('real MySQL: normal publishing pins old sessions, withdrawal closes old and in-flight replies, republishing keeps the link', async () => {
  const scope = await seed();
  await pass(scope);
  const v1 = await publish(scope);
  const publicRepo = new MySqlPublicSessionRepository(
    database,
    randomBytes(32).toString('base64url'),
  );
  const visitorNonce = randomBytes(32).toString('base64url');
  const sessionRequestId = `session_request_${freshId()}`;
  const session = await publicRepo.createSession({
    publicSlug: scope.publicSlug,
    sessionRequestId,
    visitorNonce,
    now: new Date(),
  });
  const turn = await publicRepo.acceptTurn({
    sessionHandle: session.sessionHandle,
    visitorNonce,
    clientMessageId: `message_${freshId()}`,
    content: '合成旧版问题',
    now: new Date(),
  });
  const jobs = await sql(
    `SELECT HEX(id) id,payload FROM job WHERE merchant_id=UNHEX(?) AND type='conversation.turn'`,
    [scope.merchantId],
  );
  const job = jobs[0],
    payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  const messages = await sql(
    `SELECT HEX(id) id FROM message WHERE merchant_id=UNHEX(?) AND turn_id=UNHEX(?) AND role='visitor'`,
    [scope.merchantId, turn.turnId.slice(2)],
  );
  const leaseOwner = 'governance-fixture-lease';
  await sql(
    `UPDATE job SET state='processing',lease_owner=?,lease_until=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 2 MINUTE) WHERE id=UNHEX(?)`,
    [leaseOwner, job.id],
  );
  await sql(`UPDATE message SET state='processing' WHERE id=UNHEX(?)`, [messages[0].id]);
  await repository.saveDraft({
    ...scope,
    expectedRevision: 1,
    draft: { ...draft, businessScope: '第二版合成范围' },
    now: new Date(),
  });
  await pass(scope, 2);
  const v2 = await publish(scope, 2);
  assert.equal(
    (await publicRepo.readHistory(session.sessionHandle, visitorNonce, new Date())).releaseRef,
    v1.releaseId,
  );
  const result = await repository.emergencyWithdraw({
    ...scope,
    expectedReleaseId: v2.releaseId,
    reason: '合成测试：撤回旧报价',
    now: new Date(),
  });
  assert.equal(result.withdrawnReleaseCount, 2);
  assert.equal(result.endedSessionCount, 1);
  assert.equal(await repository.findPublicSnapshot(scope.publicSlug), null);
  assert.equal((await governed(scope)).hasPublishedHistory, true);
  assert.equal((await governed(scope)).quality.state, 'not_tested');
  assert.equal((await governed(scope)).draftRevision, 3);
  await assert.rejects(() =>
    repository.savePreviewCheck({
      ...scope,
      expectedDraftRevision: 2,
      question: '撤回前已发出的旧问题',
      answer: '撤回后才返回的旧结果',
      now: new Date(),
    }),
  );
  await assert.rejects(() => publish(scope, 3), code('PREVIEW_REQUIRED'));
  await assert.rejects(
    () => publicRepo.readHistory(session.sessionHandle, visitorNonce, new Date()),
    PublicReleaseWithdrawnError,
  );
  await assert.rejects(
    () => publicRepo.readTurn(session.sessionHandle, visitorNonce, turn.turnId, new Date()),
    PublicReleaseWithdrawnError,
  );
  await assert.rejects(
    () =>
      publicRepo.resumeSession({
        publicSlug: scope.publicSlug,
        sessionRequestId,
        visitorNonce,
        now: new Date(),
      }),
    PublicReleaseWithdrawnError,
  );
  let checkedLease = false;
  const observed = {
    ...database,
    openConnection: async () => {
      const connection = await database.openConnection();
      const execute = connection.execute.bind(connection);
      connection.execute = async (statement, ...args) => {
        if (typeof statement === 'string' && statement.includes('SELECT id FROM job'))
          checkedLease = true;
        return execute(statement, ...args);
      };
      return connection;
    },
  };
  const worker = new MySqlConversationTurnJobRepository(observed);
  await assert.rejects(() =>
    worker.complete(
      {
        jobId: job.id.toLowerCase(),
        leaseOwner,
        merchantId: scope.merchantId,
        assistantId: scope.assistantId,
        sessionId: payload.sessionId,
        releaseId: v1.releaseId,
        turnId: turn.turnId.slice(2),
        visitorMessageId: messages[0].id.toLowerCase(),
        question: '合成旧版问题',
        facts: {},
        context: [],
      },
      '不得交付的旧回复',
      new Date(),
    ),
  );
  assert.equal(checkedLease, true, 'valid in-flight claim must reach the durable lease guard');
  assert.equal(
    Number(
      (
        await sql(
          `SELECT COUNT(*) total FROM message WHERE merchant_id=UNHEX(?) AND role='assistant'`,
          [scope.merchantId],
        )
      )[0].total,
    ),
    0,
  );
  assert.equal(
    (await sql(`SELECT last_error_code FROM job WHERE id=UNHEX(?)`, [job.id]))[0].last_error_code,
    'RELEASE_WITHDRAWN',
  );
  await pass(scope, 3);
  const v3 = await publish(scope, 3);
  assert.equal(v3.releaseNo, 3);
  assert.equal(
    (await repository.findPublicSnapshot(scope.publicSlug)).publicAssistantId,
    scope.publicSlug,
  );
  const fresh = await publicRepo.createSession({
    publicSlug: scope.publicSlug,
    sessionRequestId: `session_request_${freshId()}`,
    visitorNonce,
    now: new Date(),
  });
  assert.equal(fresh.releaseRef, v3.releaseId);
  await assert.rejects(
    () => publicRepo.readHistory(session.sessionHandle, visitorNonce, new Date()),
    PublicReleaseWithdrawnError,
  );
  assert.equal(
    await publicRepo.readHistory(
      session.sessionHandle,
      randomBytes(32).toString('base64url'),
      new Date(),
    ),
    null,
  );
});

test('real MySQL: viewer can inspect governance but cannot judge, rename or withdraw; cross-tenant/CAS is rejected', async () => {
  const scope = await seed();
  await pass(scope);
  const release = await publish(scope);
  const viewer = freshId();
  await sql(`INSERT INTO merchant_user(id,status) VALUES(UNHEX(?),'active')`, [viewer]);
  await sql(
    `INSERT INTO merchant_membership(merchant_id,merchant_user_id,role,status) VALUES(UNHEX(?),UNHEX(?),'viewer','active')`,
    [scope.merchantId, viewer],
  );
  const viewerScope = { ...scope, merchantUserId: viewer };
  assert.equal((await governed(viewerScope)).canManage, false);
  await assert.rejects(() =>
    repository.renameAssistant({
      ...viewerScope,
      expectedRevision: 1,
      displayName: '越权',
      now: new Date(),
    }),
  );
  await assert.rejects(() =>
    repository.emergencyWithdraw({
      ...viewerScope,
      expectedReleaseId: release.releaseId,
      reason: '越权',
      now: new Date(),
    }),
  );
  await assert.rejects(
    () =>
      repository.emergencyWithdraw({
        ...scope,
        expectedReleaseId: freshId(),
        reason: '陈旧页面',
        now: new Date(),
      }),
    code('WITHDRAWAL_CONFLICT'),
  );
  const other = await seed();
  await assert.rejects(() =>
    repository.getPublicationGovernance({
      ...scope,
      merchantId: other.merchantId,
      now: new Date(),
    }),
  );
  assert.equal(
    (await repository.findPublicSnapshot(scope.publicSlug)).releaseRef,
    release.releaseId,
  );
});

test('real MySQL: preview concurrent with revision change never approves a stale revision', async () => {
  const scope = await seed();
  const check = await repository.savePreviewCheck({
    ...scope,
    expectedDraftRevision: 1,
    question: '合成问题',
    answer: '合成回答',
    now: new Date(),
  });
  const results = await Promise.allSettled([
    repository.saveDraft({
      ...scope,
      expectedRevision: 1,
      draft: { ...draft, businessScope: '并发新范围' },
      now: new Date(),
    }),
    repository.judgePreviewCheck({
      ...scope,
      expectedDraftRevision: 1,
      checkId: check.checkId,
      verdict: 'pass',
      now: new Date(),
    }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal((await governed(scope)).quality.state, 'not_tested');
  await assert.rejects(() => publish(scope, 2), code('PREVIEW_REQUIRED'));
});

test('real MySQL: emergency withdrawal preserves an existing assistant pause', async () => {
  const scope = await seed();
  await pass(scope);
  const release = await publish(scope);
  await sql(`UPDATE assistant SET status='paused' WHERE merchant_id=UNHEX(?) AND id=UNHEX(?)`, [
    scope.merchantId,
    scope.assistantId,
  ]);
  await repository.emergencyWithdraw({
    ...scope,
    expectedReleaseId: release.releaseId,
    reason: '合成暂停场景撤回',
    now: new Date(),
  });
  assert.equal(
    (await repository.findManagementSnapshot(scope.merchantId, scope.assistantId)).status,
    'paused',
  );
  await assert.rejects(() =>
    repository.savePreviewCheck({
      ...scope,
      expectedDraftRevision: 2,
      question: '暂停不能预览',
      answer: '不得重新激活',
      now: new Date(),
    }),
  );
});

test('real MySQL: audit failure rolls back the recorded preview and cannot create a passing gate', async () => {
  const scope = await seed();
  const failing = {
    ...database,
    openConnection: async () => {
      const connection = await database.openConnection();
      const execute = connection.execute.bind(connection);
      connection.execute = async (statement, ...args) => {
        if (typeof statement === 'string' && statement.includes('INSERT INTO audit_log'))
          throw new Error('INJECTED_AUDIT_FAILURE');
        return execute(statement, ...args);
      };
      return connection;
    },
  };
  await assert.rejects(() =>
    new MySqlAssistantLifecycleRepository(failing).savePreviewCheck({
      ...scope,
      expectedDraftRevision: 1,
      question: '合成问题',
      answer: '合成回答',
      now: new Date(),
    }),
  );
  assert.equal((await governed(scope)).quality.state, 'not_tested');
  const rows = await sql(
    `SELECT COUNT(*) total FROM assistant_publication_governance WHERE merchant_id=UNHEX(?) AND assistant_id=UNHEX(?)`,
    [scope.merchantId, scope.assistantId],
  );
  assert.equal(Number(rows[0].total), 0);
});
