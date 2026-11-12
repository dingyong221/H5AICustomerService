import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  MySqlConversationTurnJobRepository,
  MySqlModelCallAttemptRepository,
} from '../dist/index.js';
import {
  database,
  lifecycle,
  publicSessions,
  seed,
  turn,
  sql,
  entitlement,
} from './runtime-stage1-fixtures.mjs';

const jobs = new MySqlConversationTurnJobRepository(database);
const attempts = new MySqlModelCallAttemptRepository(database);
const owner = 'runtime_stage1_same_owner';
const claim = (scope, now = new Date()) =>
  jobs.claimNext(now, owner, { merchantId: scope.merchantId });
const expire = (c) =>
  sql(`UPDATE job SET lease_until=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE id=UNHEX(?)`, [
    c.jobId,
  ]);
const count = async (table, scope) =>
  Number(
    (
      await sql(`SELECT COUNT(*) total FROM ${table} WHERE merchant_id=UNHEX(?)`, [
        scope.merchantId,
      ])
    )[0].total,
  );

test('real MySQL: concurrent claim uses SKIP LOCKED; same-owner reclaims fence every old mutation', async () => {
  const scope = await seed();
  await turn(scope, { legacy: true });
  const concurrent = await Promise.all([claim(scope), claim(scope)]);
  const first = concurrent.find(Boolean);
  assert.equal(concurrent.filter(Boolean).length, 1);
  assert.equal(first.payloadVersion, 0);
  assert.equal(first.claimGeneration, '1');
  await expire(first);
  const second = await claim(scope);
  assert.equal(second.claimGeneration, '2');
  for (const action of [
    () => jobs.complete(first, '旧答案', new Date()),
    () => jobs.fail(first, 'MODEL_UNAVAILABLE', new Date()),
    () => jobs.cancel(first, new Date()),
    () => jobs.releaseBeforeDispatch(first, new Date()),
  ])
    assert.equal(await action(), 'stale');
  assert.equal((await jobs.reconcile(second)).state, 'processing');
  assert.equal(await jobs.complete(second, '新答案79元', new Date()), 'applied');
  assert.equal(await count('message', scope), 2);
  assert.equal((await jobs.reconcile(second)).state, 'completed');
});

test('real MySQL: a valid-looking different session cannot be mixed into another job claim', async () => {
  const a = await seed(),
    b = await seed();
  await turn(a);
  await turn(b);
  const ca = await claim(a),
    cb = await claim(b);
  const mixed = {
    ...cb,
    jobId: ca.jobId,
    leaseOwner: ca.leaseOwner,
    claimGeneration: ca.claimGeneration,
  };
  assert.equal(await jobs.complete(mixed, '不能写入的答案', new Date()), 'stale');
  assert.equal(await jobs.fail(mixed, 'MODEL_UNAVAILABLE', new Date()), 'stale');
  assert.equal(await jobs.cancel(mixed, new Date()), 'stale');
  await assert.rejects(
    () =>
      attempts.markDispatch(
        { merchantId: b.merchantId, operation: 'consumer', claim: mixed },
        new Date(),
      ),
    (e) => e.code === 'STALE_CLAIM',
  );
  assert.equal((await jobs.reconcile(mixed)).state, 'missing');
  assert.equal(await count('model_call_attempt', a), 0);
  assert.equal(await count('model_call_attempt', b), 0);
  assert.equal(await jobs.cancel(ca, new Date()), 'applied');
  assert.equal(await jobs.cancel(cb, new Date()), 'applied');
});

test('real MySQL: release before dispatch preserves attempt and advances generation; cancel preserves terminal failure', async () => {
  const scope = await seed();
  await turn(scope);
  const first = await claim(scope);
  assert.equal(first.payloadVersion, 1);
  assert.equal(await jobs.releaseBeforeDispatch(first, new Date()), 'applied');
  const second = await claim(scope);
  assert.equal(second.claimGeneration, '2');
  assert.equal(
    Number((await sql(`SELECT attempt FROM job WHERE id=UNHEX(?)`, [second.jobId]))[0].attempt),
    2,
  );
  assert.equal(await jobs.cancel(second, new Date()), 'applied');
  assert.equal((await jobs.reconcile(second)).state, 'cancelled');
  assert.equal(
    (await sql(`SELECT error_code FROM message WHERE merchant_id=UNHEX(?)`, [scope.merchantId]))[0]
      .error_code,
    'TURN_CANCELLED',
  );
  assert.equal(await claim(scope), null);
});

test('real MySQL: cancel racing with dispatch has one generation result and no answer', async () => {
  const scope = await seed();
  await turn(scope);
  const c = await claim(scope);
  const [cancel, dispatch] = await Promise.allSettled([
    jobs.cancel(c, new Date()),
    attempts.markDispatch(
      { merchantId: scope.merchantId, operation: 'consumer', claim: c },
      new Date(),
    ),
  ]);
  assert.equal(cancel.status, 'fulfilled');
  assert.equal(cancel.value, 'applied');
  if (dispatch.status === 'fulfilled')
    await attempts.recordOutcome(dispatch.value.attemptId, 'unknown', new Date());
  else assert.equal(dispatch.reason.code, 'STALE_CLAIM');
  assert.equal((await jobs.reconcile(c)).state, 'cancelled');
  assert.equal(await jobs.complete(c, '取消后迟到答案', new Date()), 'stale');
  assert.equal(await count('message', scope), 1);
  assert.equal(await count('model_call_attempt', scope), dispatch.status === 'fulfilled' ? 1 : 0);
});

test('real MySQL: dispatch is unique per generation and unknown expiry never redelivers', async () => {
  const scope = await seed();
  const accepted = await turn(scope);
  const c = await claim(scope);
  const before = await attempts.unknownRiskCount();
  const receipt = await attempts.markDispatch(
    { merchantId: scope.merchantId, operation: 'consumer', claim: c },
    new Date(),
  );
  assert.equal(await attempts.unknownRiskCount(), before + 1);
  await assert.rejects(
    () =>
      attempts.markDispatch(
        { merchantId: scope.merchantId, operation: 'consumer', claim: c },
        new Date(),
      ),
    (e) => e.code === 'STALE_CLAIM',
  );
  assert.equal(await jobs.releaseBeforeDispatch(c, new Date()), 'stale');
  await attempts.recordOutcome(receipt.attemptId, 'unknown', new Date());
  await expire(c);
  assert.equal(await claim(scope), null);
  assert.equal((await jobs.reconcile(c)).state, 'failed');
  assert.equal(
    (await sql(`SELECT last_error_code FROM job WHERE id=UNHEX(?)`, [c.jobId]))[0].last_error_code,
    'MODEL_RESULT_UNKNOWN',
  );
  const publicResult = await publicSessions.readTurn(
    accepted.sessionHandle,
    accepted.visitorNonce,
    accepted.turnId,
    new Date(),
  );
  assert.equal(publicResult.state, 'failed');
  assert.equal(publicResult.error.code, 'MODEL_RESULT_UNKNOWN');
  assert.equal(publicResult.error.retryable, false);
  assert.equal(await jobs.complete(c, '迟到旧答案', new Date()), 'stale');
  assert.equal(await count('model_call_attempt', scope), 1);
  assert.equal(await count('message', scope), 1);
  // Verified late provider response closes exposure, without reviving the failed turn.
  await attempts.recordOutcome(receipt.attemptId, 'succeeded', new Date(), 'synthetic-late-result');
  assert.equal(await attempts.unknownRiskCount(), before);
  assert.equal((await jobs.reconcile(c)).state, 'failed');
});

test('real MySQL: unclosed dispatch recovery races with late outcome without reverse-lock deadlock', async () => {
  const scope = await seed();
  await turn(scope);
  const c = await claim(scope);
  const receipt = await attempts.markDispatch(
    { merchantId: scope.merchantId, operation: 'consumer', claim: c },
    new Date(),
  );
  await expire(c);
  await Promise.all([
    claim(scope),
    attempts.recordOutcome(receipt.attemptId, 'succeeded', new Date(), 'synthetic-race'),
  ]);
  assert.equal((await jobs.reconcile(c)).state, 'failed');
  assert.equal(await claim(scope), null);
  assert.equal(await count('model_call_attempt', scope), 1);
  assert.equal(await count('message', scope), 1);
});

test('real MySQL: old processing without receipt is unknown, while unknown versions release the accepted turn', async () => {
  const scope = await seed();
  const accepted = await turn(scope, { legacy: true });
  await sql(
    `UPDATE job SET state='processing',attempt=1,claim_generation=0,lease_owner=?,lease_until=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE id=UNHEX(?)`,
    [owner, accepted.jobId],
  );
  await sql(`UPDATE message SET state='processing' WHERE merchant_id=UNHEX(?)`, [scope.merchantId]);
  assert.equal(await claim(scope), null);
  assert.equal(
    (
      await sql(`SELECT model_outcome,last_error_code FROM job WHERE id=UNHEX(?)`, [accepted.jobId])
    )[0].model_outcome,
    'unknown',
  );
  assert.equal(await count('model_call_attempt', scope), 1);
  const other = await seed();
  const bad = await turn(other);
  await sql(`UPDATE job SET payload=JSON_SET(payload,'$.schemaVersion',99) WHERE id=UNHEX(?)`, [
    bad.jobId,
  ]);
  assert.equal(await claim(other), null);
  assert.equal(
    (await sql(`SELECT last_error_code FROM job WHERE id=UNHEX(?)`, [bad.jobId]))[0]
      .last_error_code,
    'UNSUPPORTED_JOB_VERSION',
  );
  assert.equal(
    (
      await sql(`SELECT active_turn_id FROM conversation_session WHERE merchant_id=UNHEX(?)`, [
        other.merchantId,
      ])
    )[0].active_turn_id,
    null,
  );
  assert.equal(await count('model_call_attempt', other), 0);
});

test('real MySQL: legacy merchant synchronous operations all receive durable receipts', async () => {
  const scope = await seed();
  const before = await attempts.unknownRiskCount();
  for (const operation of ['preview', 'writing', 'organize']) {
    const r = await attempts.markDispatch({ merchantId: scope.merchantId, operation }, new Date());
    await attempts.recordOutcome(r.attemptId, 'succeeded', new Date());
    await attempts.recordOutcome(r.attemptId, 'unknown', new Date()); // cannot regress known result
  }
  assert.equal(await count('model_call_attempt', scope), 3);
  assert.equal(await attempts.unknownRiskCount(), before);
  assert.equal(
    Number(
      (
        await sql(
          `SELECT COUNT(*) total FROM marketplace_model_attempt m JOIN marketplace_allocation a ON a.subject_digest=m.subject_digest AND a.product=m.product WHERE a.merchant_id=UNHEX(?)`,
          [scope.merchantId],
        )
      )[0].total,
    ),
    0,
  );
});

test('real MySQL: concurrent quota is reserved once with matching old and universal ledgers', async () => {
  const scope = await seed();
  const subject = await entitlement(scope, 1);
  const results = await Promise.allSettled(
    ['preview', 'writing'].map((operation) =>
      attempts.markDispatch({ merchantId: scope.merchantId, operation }, new Date()),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'quota_exhausted');
  assert.equal(
    Number(
      (
        await sql(
          `SELECT model_calls_reserved n FROM marketplace_entitlement WHERE subject_digest=?`,
          [subject],
        )
      )[0].n,
    ),
    1,
  );
  assert.equal(
    Number(
      (
        await sql(`SELECT COUNT(*) n FROM marketplace_model_attempt WHERE subject_digest=?`, [
          subject,
        ])
      )[0].n,
    ),
    1,
  );
  assert.equal(await count('model_call_attempt', scope), 1);
  await attempts.recordOutcome(
    results.find((r) => r.status === 'fulfilled').value.attemptId,
    'unknown',
    new Date(),
  );
  assert.equal(
    Number(
      (
        await sql(
          `SELECT model_calls_reserved n FROM marketplace_entitlement WHERE subject_digest=?`,
          [subject],
        )
      )[0].n,
    ),
    1,
  );
  await sql(`UPDATE marketplace_entitlement SET status='paused' WHERE subject_digest=?`, [subject]);
  await assert.rejects(
    () =>
      attempts.markDispatch({ merchantId: scope.merchantId, operation: 'organize' }, new Date()),
    (e) => e.code === 'not_eligible',
  );
  assert.equal(await count('model_call_attempt', scope), 1);
});

test('real MySQL: emergency withdrawal blocks generation submission and supplier dispatch', async () => {
  const scope = await seed();
  await turn(scope);
  const c = await claim(scope);
  await lifecycle.emergencyWithdraw({
    ...scope,
    expectedReleaseId: scope.releaseId,
    reason: '合成撤回竞态',
    now: new Date(),
  });
  assert.equal(await jobs.complete(c, '撤回后的旧答案', new Date()), 'stale');
  assert.equal(await jobs.fail(c, 'MODEL_UNAVAILABLE', new Date()), 'stale');
  await assert.rejects(
    () =>
      attempts.markDispatch(
        { merchantId: scope.merchantId, operation: 'consumer', claim: c },
        new Date(),
      ),
    (e) => e.code === 'STALE_CLAIM',
  );
  assert.equal(await count('message', scope), 1);
});

test('real MySQL: withdrawal racing with late outcome preserves withdrawn turn and receipt', async () => {
  const scope = await seed();
  await turn(scope);
  const c = await claim(scope);
  const receipt = await attempts.markDispatch(
    { merchantId: scope.merchantId, operation: 'consumer', claim: c },
    new Date(),
  );
  await attempts.recordOutcome(receipt.attemptId, 'unknown', new Date());
  await Promise.all([
    lifecycle.emergencyWithdraw({
      ...scope,
      expectedReleaseId: scope.releaseId,
      reason: '合成撤回迟到结果竞态',
      now: new Date(),
    }),
    attempts.recordOutcome(receipt.attemptId, 'succeeded', new Date(), 'synthetic-withdrawal-race'),
  ]);
  assert.equal((await jobs.reconcile(c)).state, 'failed');
  assert.equal((await jobs.reconcile(c)).modelOutcome, 'succeeded');
  assert.equal(await jobs.complete(c, '撤回后迟到答案', new Date()), 'stale');
  assert.equal(await count('message', scope), 1);
  assert.equal(await count('model_call_attempt', scope), 1);
});

test('real MySQL: commit response loss is reconciled, without a duplicate answer or dispatch', async () => {
  const lostCommit = {
    ...database,
    openConnection: async () => {
      const connection = await database.openConnection();
      const commit = connection.commit.bind(connection);
      connection.commit = async () => {
        await commit();
        throw new Error('synthetic lost commit acknowledgment');
      };
      return connection;
    },
  };
  const uncertainJobs = new MySqlConversationTurnJobRepository(lostCommit);
  const scope = await seed();
  await turn(scope);
  const c = await claim(scope);
  await assert.rejects(() => uncertainJobs.complete(c, '已提交但确认丢失', new Date()));
  assert.equal((await jobs.reconcile(c)).state, 'completed');
  assert.equal(await jobs.complete(c, '第二答案禁止', new Date()), 'stale');
  assert.equal(await count('message', scope), 2);
  const other = await seed();
  await turn(other);
  const co = await claim(other);
  const uncertainAttempts = new MySqlModelCallAttemptRepository(lostCommit);
  await assert.rejects(
    () =>
      uncertainAttempts.markDispatch(
        { merchantId: other.merchantId, operation: 'consumer', claim: co },
        new Date(),
      ),
    (e) => e.code === 'MODEL_DISPATCH_UNKNOWN',
  );
  assert.equal((await jobs.reconcile(co)).modelOutcome, 'dispatched');
  await assert.rejects(
    () =>
      attempts.markDispatch(
        { merchantId: other.merchantId, operation: 'consumer', claim: co },
        new Date(),
      ),
    (e) => e.code === 'STALE_CLAIM',
  );
  assert.equal(await count('model_call_attempt', other), 1);
});

test('real MySQL: merchant-head cursor covers more than one page without global FIFO truncation', async () => {
  const inserted = [];
  for (let index = 0; index < 65; index++) {
    const id = randomBytes(16);
    inserted.push(id.toString('hex'));
    await sql(`INSERT INTO merchant(id,name,status) VALUES(?,'分页合成商家','active')`, [id]);
    await sql(
      `INSERT INTO job(id,merchant_id,type,dedup_key,payload,state,run_after) VALUES(?,?,'conversation.turn',?,'{}','pending',UTC_TIMESTAMP(6))`,
      [randomBytes(16), id, randomBytes(32)],
    );
  }
  let cursor;
  const all = [];
  do {
    const page = await jobs.listRunnableMerchantHeads(new Date(), {
      limit: 32,
      ...(cursor ? { afterMerchantId: cursor } : {}),
    });
    all.push(...page.map((row) => row.merchantId));
    cursor = page.at(-1)?.merchantId;
    if (page.length < 32) break;
  } while (true);
  assert.equal(new Set(all).size, all.length);
  for (const id of inserted) assert.ok(all.includes(id));
  for (const id of inserted)
    await sql(
      `UPDATE job SET state='failed',last_error_code='SYNTHETIC_PAGE_PROBE' WHERE merchant_id=UNHEX(?)`,
      [id],
    );
});
