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
  const snapshot = await repository.findManagementSnapshot(scope.merchantId, scope.assistantId);
  const check = await repository.savePreviewCheck({
    ...scope,
    expectedPreviousPreviewId: snapshot.previousPreviewCheckId,
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
test('real MySQL: concurrent distinct creation requests from two members reuse one assistant without overwriting it', async () => {
  const scope = await seed();
  const secondUser = freshId();
  await sql("INSERT INTO merchant_user(id,status) VALUES(UNHEX(?),'active')", [secondUser]);
  await sql(
    "INSERT INTO merchant_membership(merchant_id,merchant_user_id,role,status) VALUES(UNHEX(?),UNHEX(?),'editor','active')",
    [scope.merchantId, secondUser],
  );
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      repository.createManualDraft({
        ...scope,
        merchantUserId: index % 2 ? secondUser : scope.merchantUserId,
        displayName: '不得覆盖的重复请求' + index,
        draft: { ...draft, pricingSummary: '不得覆盖：1元' },
        idempotency: idempotency(),
        now: new Date(),
      }),
    ),
  );
  assert.ok(
    results.every((result) => result.assistantId === scope.assistantId && result.reusedExisting),
  );
  assert.equal(
    Number(
      (
        await sql('SELECT COUNT(*) total FROM assistant WHERE merchant_id=UNHEX(?)', [
          scope.merchantId,
        ])
      )[0].total,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await sql('SELECT COUNT(*) total FROM merchant_assistant WHERE merchant_id=UNHEX(?)', [
          scope.merchantId,
        ])
      )[0].total,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await sql(
          "SELECT COUNT(*) total FROM outbox_event WHERE merchant_id=UNHEX(?) AND event_type='assistant.created'",
          [scope.merchantId],
        )
      )[0].total,
    ),
    1,
  );
  assert.equal(
    (await repository.findManagementSnapshot(scope.merchantId, scope.assistantId)).draft
      .pricingSummary,
    draft.pricingSummary,
  );
  assert.equal((await repository.listMerchantAssistants(secondUser, scope.merchantId)).length, 1);
  const foreign = await seed();
  await assert.rejects(() =>
    repository.createManualDraft({
      ...scope,
      merchantUserId: foreign.merchantUserId,
      displayName: '越权',
      draft,
      idempotency: idempotency(),
      now: new Date(),
    }),
  );
  assert.equal(
    (await repository.listMerchantAssistants(foreign.merchantUserId, scope.merchantId)).length,
    0,
  );
  await assert.rejects(() =>
    sql('UPDATE merchant_assistant SET assistant_id=UNHEX(?) WHERE merchant_id=UNHEX(?)', [
      foreign.assistantId,
      scope.merchantId,
    ]),
  );
});

test('real MySQL: simultaneous first creation is serialized at merchant scope', async () => {
  const merchantId = freshId(),
    merchantUserId = freshId();
  await sql("INSERT INTO merchant(id,name,status) VALUES(UNHEX(?),'并发首次开通','active')", [
    merchantId,
  ]);
  await sql("INSERT INTO merchant_user(id,status) VALUES(UNHEX(?),'active')", [merchantUserId]);
  await sql(
    "INSERT INTO merchant_membership(merchant_id,merchant_user_id,role,status) VALUES(UNHEX(?),UNHEX(?),'owner','active')",
    [merchantId, merchantUserId],
  );
  const replies = await Promise.all(
    Array.from({ length: 10 }, () =>
      repository.createManualDraft({
        merchantId,
        merchantUserId,
        displayName: '唯一客服',
        draft,
        idempotency: idempotency(),
        now: new Date(),
      }),
    ),
  );
  assert.equal(new Set(replies.map((reply) => reply.assistantId)).size, 1);
  assert.equal(replies.filter((reply) => !reply.reusedExisting).length, 1);
  assert.equal(
    Number(
      (
        await sql('SELECT COUNT(*) total FROM assistant WHERE merchant_id=UNHEX(?)', [merchantId])
      )[0].total,
    ),
    1,
  );
});

test('real MySQL: onboarding and manual creation race for the same binding and subsequent onboarding never overwrites it', async () => {
  const merchantId = freshId(),
    merchantUserId = freshId(),
    onboardingSessionId = freshId();
  await sql("INSERT INTO merchant(id,name,status) VALUES(UNHEX(?),'引导与手工竞态','active')", [
    merchantId,
  ]);
  await sql("INSERT INTO merchant_user(id,status) VALUES(UNHEX(?),'active')", [merchantUserId]);
  await sql(
    "INSERT INTO merchant_membership(merchant_id,merchant_user_id,role,status) VALUES(UNHEX(?),UNHEX(?),'owner','active')",
    [merchantId, merchantUserId],
  );
  const answers = {
    businessName: '合成引导商家',
    businessDescription: '清洗咨询',
    industryCode: 'home-service',
    materials: [{ summary: '合成清洗服务手册' }],
    pricingPolicy: {
      availability: 'provided',
      facts: [{ offeringName: '挂机清洗', amount: '79', currency: 'CNY' }],
    },
    promotionPolicy: { availability: 'none_confirmed', facts: [] },
    insufficientFactPolicy: 'contact_merchant',
    merchantConfirmed: true,
  };
  const insertOnboarding = (id, value) =>
    sql(
      "INSERT INTO onboarding_session(id,merchant_id,merchant_user_id,state,answers,missing_items) VALUES(UNHEX(?),UNHEX(?),UNHEX(?),'generating',?,JSON_ARRAY())",
      [id, merchantId, merchantUserId, JSON.stringify(value)],
    );
  await insertOnboarding(onboardingSessionId, answers);
  const [generated, manual] = await Promise.all([
    repository.generateDraftFromOnboarding({
      merchantId,
      merchantUserId,
      onboardingSessionId,
      idempotency: idempotency(),
      now: new Date(),
    }),
    repository.createManualDraft({
      merchantId,
      merchantUserId,
      displayName: '手工开通合成客服',
      draft,
      idempotency: idempotency(),
      now: new Date(),
    }),
  ]);
  assert.equal(generated.assistantId, manual.assistantId);
  assert.equal(generated.publicSlug, manual.publicSlug);
  assert.equal(
    Number(
      (
        await sql('SELECT COUNT(*) total FROM assistant WHERE merchant_id=UNHEX(?)', [merchantId])
      )[0].total,
    ),
    1,
  );
  const before = await repository.findManagementSnapshot(merchantId, generated.assistantId);
  const nextOnboarding = freshId();
  await insertOnboarding(nextOnboarding, {
    ...answers,
    businessName: '不得覆盖旧客服',
    materials: [{ summary: '不得覆盖资料' }],
  });
  const repeated = await repository.generateDraftFromOnboarding({
    merchantId,
    merchantUserId,
    onboardingSessionId: nextOnboarding,
    idempotency: idempotency(),
    now: new Date(),
  });
  assert.equal(repeated.assistantId, generated.assistantId);
  assert.deepEqual(repeated, before);
  const sessions = await sql(
    'SELECT state,LOWER(HEX(assistant_id)) assistantId FROM onboarding_session WHERE merchant_id=UNHEX(?)',
    [merchantId],
  );
  assert.ok(
    sessions.every(
      (row) => row.state === 'manageable' && row.assistantId === generated.assistantId,
    ),
  );
});

test('real MySQL: two consumers share the assistant, never conversation context; copied references and cross-tenant handles cannot authorize', async () => {
  const scope = await seed();
  await pass(scope);
  await publish(scope);
  const publicRepo = new MySqlPublicSessionRepository(
    database,
    randomBytes(32).toString('base64url'),
  );
  const worker = new MySqlConversationTurnJobRepository(database);
  const nonceA = randomBytes(32).toString('base64url'),
    nonceB = randomBytes(32).toString('base64url');
  const refA = 'session_request_' + freshId(),
    refB = 'session_request_' + freshId();
  const open = (ref, nonce) =>
    publicRepo.createSession({
      publicSlug: scope.publicSlug,
      sessionRequestId: ref,
      visitorNonce: nonce,
      now: new Date(),
    });
  const a = await open(refA, nonceA),
    b = await open(refB, nonceB);
  assert.notEqual(a.sessionHandle, b.sessionHandle);
  const submit = (session, nonce, content) =>
    publicRepo.acceptTurn({
      sessionHandle: session.sessionHandle,
      visitorNonce: nonce,
      clientMessageId: 'message_' + freshId(),
      content,
      now: new Date(),
    });
  await submit(a, nonceA, '消费者A：我的称呼是小林');
  const firstA = await worker.claimNext(new Date(), 'single_context_probe');
  assert.equal(firstA.question, '消费者A：我的称呼是小林');
  assert.deepEqual(firstA.context, []);
  await worker.complete(firstA, '您好小林，请问需要什么？', new Date());
  await submit(b, nonceB, '消费者B：我叫什么？');
  const firstB = await worker.claimNext(new Date(), 'single_context_probe');
  assert.equal(firstB.assistantId, firstA.assistantId);
  assert.notEqual(firstB.sessionId, firstA.sessionId);
  assert.deepEqual(firstB.context, []);
  await worker.complete(firstB, '您尚未提供称呼。', new Date());
  await submit(a, nonceA, '你还记得我叫什么吗？');
  const secondA = await worker.claimNext(new Date(), 'single_context_probe');
  assert.deepEqual(secondA.context, [
    { role: 'visitor', content: '消费者A：我的称呼是小林' },
    { role: 'assistant', content: '您好小林，请问需要什么？' },
  ]);
  await worker.complete(secondA, '您刚才说您的称呼是小林。', new Date());
  const resumed = await publicRepo.resumeSession({
    publicSlug: scope.publicSlug,
    sessionRequestId: refA,
    visitorNonce: nonceA,
    now: new Date(),
  });
  assert.equal(resumed.sessionHandle, a.sessionHandle);
  assert.equal(
    (await publicRepo.readHistory(a.sessionHandle, nonceA, new Date())).messages.length,
    4,
  );
  assert.equal(await publicRepo.readHistory(a.sessionHandle, nonceB, new Date()), null);
  assert.equal(
    await publicRepo.readTurn(a.sessionHandle, nonceB, 't-' + firstA.turnId, new Date()),
    null,
  );
  const copied = await publicRepo.resumeSession({
    publicSlug: scope.publicSlug,
    sessionRequestId: refA,
    visitorNonce: nonceB,
    now: new Date(),
  });
  assert.equal(copied, null);
  const other = await seed();
  await pass(other);
  await publish(other);
  assert.equal(
    await publicRepo.resumeSession({
      publicSlug: other.publicSlug,
      sessionRequestId: refA,
      visitorNonce: nonceA,
      now: new Date(),
    }),
    null,
  );
  const expired = new Date(Date.now() + 31 * 60_000);
  assert.equal(await publicRepo.readHistory(b.sessionHandle, nonceB, expired), null);
  await publicRepo.endSession({
    sessionHandle: a.sessionHandle,
    visitorNonce: nonceA,
    now: new Date(),
  });
  assert.equal(await publicRepo.readHistory(a.sessionHandle, nonceA, new Date()), null);
  const freshA = await open('session_request_' + freshId(), nonceA);
  await submit(freshA, nonceA, '新的咨询');
  const restart = await worker.claimNext(new Date(), 'single_context_probe');
  assert.deepEqual(restart.context, []);
  await worker.complete(restart, '这是新的咨询。', new Date());
});
