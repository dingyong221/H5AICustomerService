import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MySqlRuntimeExecutionControlRepository,
  MySqlRuntimeObservationRepository,
  MySqlAuthoringTaskRepository,
  MySqlModelCallAttemptRepository,
  MySqlConversationTurnJobRepository,
  RuntimeExecutionBlockedError,
} from '../dist/index.js';
import {
  database,
  lifecycle,
  attempts,
  jobs,
  seed,
  sql,
  fresh,
  request,
  publicSessions,
  entitlement,
} from './knowledge-stage2-fixtures.mjs';
assert.equal(process.env.RUNTIME_EXECUTION_CONTROL_ENABLED, 'true');
const controls = new MySqlRuntimeExecutionControlRepository(database, true),
  authoring = new MySqlAuthoringTaskRepository(database, { draftExpand: true, previewReply: true });
const now = () => new Date(),
  scope = (s) => ({ kind: 'merchant', merchantId: s.merchantId }),
  jobScope = (id) => ({ kind: 'job', jobId: id });
const command = async (sc, action = 'pause', patch = {}) =>
  controls.change({
    scope: sc,
    action,
    expectedRevision: (await controls.read(sc)).revision,
    requestId: 'runtime_' + fresh(),
    reason: '合成运行控制测试',
    confirmed: true,
    operatorId: 'synthetic_ops',
    now: now(),
    ...patch,
  });
test.beforeEach(async () => {
  await command({ kind: 'global' }, 'resume');
});
const writing = (s) => ({
  ...s,
  requestId: 'authoring_' + fresh(),
  revision: 1,
  field: 'industry',
  brief: '家居零售',
  currentText: '家居',
  consent: true,
  now: now(),
});
const preview = (s) => ({
  ...s,
  requestId: 'authoring_' + fresh(),
  revision: 1,
  question: '合成运费问题',
  now: now(),
});
const claim = (s, kind = 'draft.expand') =>
  authoring.claimNext(now(), 'stage3_sql_owner', { merchantId: s.merchantId, kind });
const dispatch = (c) =>
  attempts.markDispatch(
    {
      merchantId: c.merchantId,
      operation: c.payload.kind === 'draft.expand' ? 'writing' : 'preview',
      authoringClaim: c,
    },
    now(),
  );
const count = async (s, table = 'model_call_attempt') =>
  (await sql(`SELECT COUNT(*) n FROM ${table} WHERE merchant_id=UNHEX(?)`, [s.merchantId]))[0].n;
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function configWithCommit(action) {
  return {
    ...database,
    openConnection: async () => {
      const c = await database.openConnection(),
        original = c.commit.bind(c);
      c.commit = () => action(original);
      return c;
    },
  };
}
// Signals only after the second connection has actually issued its locking
// query. The first connection still owns global until the test releases COMMIT.
function configWithGateIssued(issued) {
  return {
    ...database,
    openConnection: async () => {
      const c = await database.openConnection(),
        execute = c.execute.bind(c);
      c.execute = (statement, parameters) => {
        const pending = execute(statement, parameters);
        if (
          statement.includes('runtime_execution_control') &&
          statement.includes('FOR UPDATE') &&
          parameters?.[0] === 'global'
        )
          issued.resolve();
        return pending;
      };
      return c;
    },
  };
}

test('runtime SQL R01: three scopes persist and explicit resume changes only that scope without business mutations', async () => {
  const s = await seed(),
    input = writing(s),
    task = await authoring.enqueueDraftExpand(input),
    before = await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId);
  for (const sc of [{ kind: 'global' }, scope(s), jobScope(task.taskId)]) await command(sc);
  await command({ kind: 'global' }, 'resume');
  await command(scope(s), 'resume');
  assert.equal(
    await new MySqlRuntimeExecutionControlRepository(database, true).readEffective({
      merchantId: s.merchantId,
      jobId: task.taskId,
    }),
    'paused',
  );
  assert.equal(await claim(s), null);
  assert.equal((await authoring.enqueueDraftExpand(input)).taskId, task.taskId);
  await command(jobScope(task.taskId), 'resume');
  assert.ok(await claim(s));
  const after = await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId);
  assert.equal(after.draftRevision, before.draftRevision);
  assert.equal(after.activeReleaseId, before.activeReleaseId);
  assert.equal(after.publicSlug, before.publicSlug);
  assert.equal(
    (await sql('SELECT status FROM merchant WHERE id=UNHEX(?)', [s.merchantId]))[0].status,
    'active',
  );
});
test('runtime SQL R02: paused job does not block another job or another merchant, and task read/cancel remain authorized', async () => {
  const a = await seed(),
    b = await seed(),
    x = await authoring.enqueueDraftExpand(writing(a)),
    y = await authoring.enqueueDraftExpand(writing(a));
  await command(jobScope(x.taskId));
  const c = await claim(a);
  assert.equal(c.jobId, y.taskId);
  await command(scope(a));
  await authoring.enqueueDraftExpand(writing(b));
  assert.ok(await claim(b));
  assert.equal(await authoring.getExecutionState(a, x.taskId), 'paused');
  await assert.rejects(authoring.getExecutionState(b, x.taskId));
  assert.equal((await authoring.cancel(a, x.taskId, now())).state, 'cancelled');
});
test('runtime SQL R03: global/merchant pause rejects new knowledge/writing/preview and consumer admissions, while original keys replay', async () => {
  const s = await seed(),
    w = writing(s),
    p = preview(s),
    k = request(s),
    wt = await authoring.enqueueDraftExpand(w),
    pt = await authoring.enqueuePreviewReply(p),
    kt = await jobs.enqueue(k);
  const nonce = Buffer.alloc(32, 7).toString('base64url'),
    session = await publicSessions.createSession({
      publicSlug: s.publicSlug,
      sessionRequestId: 'session_request_' + fresh(),
      visitorNonce: nonce,
      now: now(),
    });
  const turnInput = {
      sessionHandle: session.sessionHandle,
      visitorNonce: nonce,
      clientMessageId: 'message_' + fresh(),
      content: '合成问题',
      now: now(),
    },
    accepted = await publicSessions.acceptTurn(turnInput);
  await command(scope(s));
  assert.equal((await authoring.enqueueDraftExpand(w)).taskId, wt.taskId);
  assert.equal((await authoring.enqueuePreviewReply(p)).taskId, pt.taskId);
  assert.equal((await jobs.enqueue(k)).taskId, kt.taskId);
  assert.deepEqual(await publicSessions.acceptTurn(turnInput), accepted);
  for (const fn of [
    () => authoring.enqueueDraftExpand(writing(s)),
    () => authoring.enqueuePreviewReply(preview(s)),
    () => jobs.enqueue(request(s)),
  ])
    await assert.rejects(fn, RuntimeExecutionBlockedError);
  const otherSession = await publicSessions.createSession({
    publicSlug: s.publicSlug,
    sessionRequestId: 'session_request_' + fresh(),
    visitorNonce: nonce,
    now: now(),
  });
  await assert.rejects(
    publicSessions.acceptTurn({
      ...turnInput,
      sessionHandle: otherSession.sessionHandle,
      clientMessageId: 'message_' + fresh(),
    }),
    RuntimeExecutionBlockedError,
  );
  assert.equal(
    await publicSessions.readTurnExecutionState(
      session.sessionHandle,
      nonce,
      accepted.turnId,
      now(),
    ),
    'paused',
  );
  await assert.rejects(
    publicSessions.readTurnExecutionState(
      session.sessionHandle,
      Buffer.alloc(32, 8).toString('base64url'),
      accepted.turnId,
      now(),
    ),
  );
  assert.equal(await count(s), 0);
});
test('runtime SQL R04: one CAS winner, durable request receipts and old-key replay after later commands', async () => {
  const s = await seed(),
    sc = scope(s),
    input = {
      scope: sc,
      action: 'pause',
      expectedRevision: '0',
      requestId: 'runtime_' + fresh(),
      reason: '合成并发控制命令',
      confirmed: true,
      operatorId: 'synthetic_ops',
      now: now(),
    };
  const results = await Promise.allSettled([
    controls.change(input),
    controls.change({ ...input, requestId: 'runtime_' + fresh() }),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const winner = results.find((x) => x.status === 'fulfilled').value;
  await command(sc, 'resume');
  const receipt = await controls.findReceipt({
    operatorId: 'synthetic_ops',
    requestId: winner.requestId,
  });
  assert.deepEqual(receipt, winner);
  assert.deepEqual(await controls.change({ ...input, requestId: winner.requestId }), winner);
  assert.equal((await controls.read(sc)).state, 'active');
  await assert.rejects(
    controls.change({ ...input, requestId: winner.requestId, action: 'resume' }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    await controls.findReceipt({ operatorId: 'different_ops', requestId: winner.requestId }),
    null,
  );
});
test('runtime SQL R05: lost control COMMIT is recovered by same request without another revision or audit', async () => {
  const s = await seed(),
    input = {
      scope: scope(s),
      action: 'pause',
      expectedRevision: '0',
      requestId: 'runtime_' + fresh(),
      reason: '合成丢失提交回执',
      confirmed: true,
      operatorId: 'synthetic_ops',
      now: now(),
    };
  const lost = new MySqlRuntimeExecutionControlRepository(
    configWithCommit(async (commit) => {
      await commit();
      throw Error('lost acknowledgement');
    }),
    true,
  );
  await assert.rejects(lost.change(input), (e) => e.code === 'WRITE_OUTCOME_UNKNOWN');
  const receipt = await controls.findReceipt({
    operatorId: input.operatorId,
    requestId: input.requestId,
  });
  assert.equal(receipt.revision, '1');
  assert.deepEqual(await controls.change(input), receipt);
  assert.equal((await controls.read(scope(s))).revision, '1');
  assert.equal(
    (await sql('SELECT COUNT(*) n FROM audit_log WHERE request_id=?', [input.requestId]))[0].n,
    1,
  );
});
test('runtime SQL R06: failed control COMMIT rolls back control/audit/receipt and same request can safely retry', async () => {
  const s = await seed(),
    input = {
      scope: scope(s),
      action: 'pause',
      expectedRevision: '0',
      requestId: 'runtime_' + fresh(),
      reason: '合成提交之前失败',
      confirmed: true,
      operatorId: 'synthetic_ops',
      now: now(),
    };
  const failed = new MySqlRuntimeExecutionControlRepository(
    configWithCommit(async () => {
      throw Error('before commit');
    }),
    true,
  );
  await assert.rejects(failed.change(input), (e) => e.code === 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(
    await controls.findReceipt({ operatorId: input.operatorId, requestId: input.requestId }),
    null,
  );
  assert.equal((await controls.read(scope(s))).revision, '0');
  await controls.change(input);
  assert.equal((await controls.read(scope(s))).state, 'manually_stopped');
});
test('runtime SQL R07: pause commits before blocked dispatch gets global lock, leaving zero attempts and fees', async () => {
  const s = await seed();
  await entitlement(s);
  await authoring.enqueueDraftExpand(writing(s));
  const c = await claim(s),
    entered = deferred(),
    release = deferred();
  const pauser = new MySqlRuntimeExecutionControlRepository(
    configWithCommit(async (commit) => {
      entered.resolve();
      await release.promise;
      await commit();
    }),
    true,
  );
  const input = {
    scope: scope(s),
    action: 'pause',
    expectedRevision: '0',
    requestId: 'runtime_' + fresh(),
    reason: '合成暂停派发竞态',
    confirmed: true,
    operatorId: 'synthetic_ops',
    now: now(),
  };
  const pausing = pauser.change(input);
  await entered.promise;
  const issued = deferred();
  const sending = new MySqlModelCallAttemptRepository(configWithGateIssued(issued)).markDispatch(
    { merchantId: s.merchantId, operation: 'writing', authoringClaim: c },
    now(),
  );
  await issued.promise;
  release.resolve();
  await pausing;
  await assert.rejects(sending, RuntimeExecutionBlockedError);
  assert.equal(await count(s), 0);
  assert.equal(
    (
      await new MySqlRuntimeObservationRepository(database).read({
        merchantId: s.merchantId,
        from: new Date(Date.now() - 60000),
        to: new Date(Date.now() + 60000),
      })
    ).reservations.reservedCalls,
    0,
  );
});
test('runtime SQL R08: dispatch wins shared lock, later pause permits drain and independent result receipt', async () => {
  const s = await seed();
  await authoring.enqueueDraftExpand(writing(s));
  const c = await claim(s),
    entered = deferred(),
    release = deferred();
  const store = new MySqlModelCallAttemptRepository(
    configWithCommit(async (commit) => {
      entered.resolve();
      await release.promise;
      await commit();
    }),
  );
  const sending = store.markDispatch(
    { merchantId: s.merchantId, operation: 'writing', authoringClaim: c },
    now(),
  );
  await entered.promise;
  const issued = deferred();
  const pausing = new MySqlRuntimeExecutionControlRepository(
    configWithGateIssued(issued),
    true,
  ).change({
    scope: scope(s),
    action: 'pause',
    expectedRevision: '0',
    requestId: 'runtime_' + fresh(),
    reason: '合成晚提交暂停竞态',
    confirmed: true,
    operatorId: 'synthetic_ops',
    now: now(),
  });
  await issued.promise;
  release.resolve();
  const receipt = await sending;
  await pausing;
  assert.equal(await authoring.getExecutionState(s, c.jobId), 'draining');
  await attempts.recordOutcome(receipt.attemptId, 'succeeded', now(), 'synthetic-response');
  await authoring.complete(c, { options: ['家居零售', '家居用品'], reminders: [] }, now());
  assert.equal((await authoring.get(s, c.jobId)).state, 'completed');
  assert.equal(await authoring.getExecutionState(s, c.jobId), 'not-applicable');
});
test('runtime SQL R09: all synchronous operations obey global/merchant controls and unknown reservations are never undone', async () => {
  const s = await seed();
  await command(scope(s));
  for (const operation of ['preview', 'writing', 'organize'])
    await assert.rejects(
      attempts.markDispatch({ merchantId: s.merchantId, operation }, now()),
      RuntimeExecutionBlockedError,
    );
  await command(scope(s), 'resume');
  const r = await attempts.markDispatch({ merchantId: s.merchantId, operation: 'preview' }, now());
  await attempts.recordOutcome(r.attemptId, 'unknown', now());
  await command({ kind: 'global' });
  for (const operation of ['preview', 'writing', 'organize'])
    await assert.rejects(
      attempts.markDispatch({ merchantId: s.merchantId, operation }, now()),
      RuntimeExecutionBlockedError,
    );
  await command({ kind: 'global' }, 'resume');
  assert.equal(
    (await sql('SELECT state FROM model_call_attempt WHERE id=UNHEX(?)', [r.attemptId]))[0].state,
    'unknown',
  );
  assert.equal(await count(s), 1);
});
test('runtime SQL R10: six claim-pause-release cycles refund only unused attempt once and never reverse generation', async () => {
  const s = await seed(),
    t = await authoring.enqueueDraftExpand(writing(s));
  let previous = '0';
  for (let i = 0; i < 6; i++) {
    const c = await claim(s);
    assert.ok(BigInt(c.claimGeneration) > BigInt(previous));
    previous = c.claimGeneration;
    await command(jobScope(t.taskId));
    await assert.rejects(dispatch(c), RuntimeExecutionBlockedError);
    assert.equal(
      await authoring.releaseBeforeDispatch(c, now(), { reason: 'runtime_paused' }),
      'applied',
    );
    assert.equal(
      await authoring.releaseBeforeDispatch(c, now(), { reason: 'runtime_paused' }),
      'stale',
    );
    await command(jobScope(t.taskId), 'resume');
  }
  const c = await claim(s);
  assert.equal(c.claimGeneration, '7');
  const r = await dispatch(c);
  await attempts.recordOutcome(r.attemptId, 'unknown', now());
  assert.equal(
    await authoring.releaseBeforeDispatch(c, now(), { reason: 'runtime_paused' }),
    'stale',
  );
  assert.equal((await sql('SELECT attempt FROM job WHERE id=UNHEX(?)', [t.taskId]))[0].attempt, 1);
});
test('runtime SQL R11: knowledge pause/claim release cycles preserve retry budget and source contracts', async () => {
  const s = await seed(),
    t = await jobs.enqueue(request(s));
  for (let i = 0; i < 6; i++) {
    const c = await jobs.claimNext(now(), 'stage3_knowledge_owner', { merchantId: s.merchantId });
    assert.ok(c);
    await command(jobScope(t.taskId));
    await assert.rejects(
      attempts.markDispatch(
        { merchantId: s.merchantId, operation: 'organize', knowledgeClaim: c },
        now(),
      ),
      RuntimeExecutionBlockedError,
    );
    assert.equal(
      await jobs.releaseBeforeDispatch(c, now(), { reason: 'runtime_paused' }),
      'applied',
    );
    await command(jobScope(t.taskId), 'resume');
  }
  assert.equal(
    (
      await sql(
        'SELECT attempt,CAST(claim_generation AS CHAR) generation FROM job WHERE id=UNHEX(?)',
        [t.taskId],
      )
    )[0].attempt,
    0,
  );
});
test('runtime SQL R12: consumer pause/claim release fences old generation and keeps the same accepted turn', async () => {
  const s = await seed(),
    nonce = Buffer.alloc(32, 9).toString('base64url'),
    session = await publicSessions.createSession({
      publicSlug: s.publicSlug,
      sessionRequestId: 'session_request_' + fresh(),
      visitorNonce: nonce,
      now: now(),
    });
  const t = await publicSessions.acceptTurn({
      sessionHandle: session.sessionHandle,
      visitorNonce: nonce,
      clientMessageId: 'message_' + fresh(),
      content: '阶段3合成消费者',
      now: now(),
    }),
    store = new MySqlConversationTurnJobRepository(database);
  for (let i = 0; i < 6; i++) {
    const c = await store.claimNext(now(), 'stage3_consumer_owner', { merchantId: s.merchantId });
    assert.ok(c);
    await command(jobScope(c.jobId));
    await assert.rejects(
      attempts.markDispatch({ merchantId: s.merchantId, operation: 'consumer', claim: c }, now()),
      RuntimeExecutionBlockedError,
    );
    assert.equal(
      await store.releaseBeforeDispatch(c, now(), { reason: 'runtime_paused' }),
      'applied',
    );
    assert.equal(
      await store.releaseBeforeDispatch(c, now(), { reason: 'runtime_paused' }),
      'stale',
    );
    await command(jobScope(c.jobId), 'resume');
  }
  assert.equal(
    (await publicSessions.readTurn(session.sessionHandle, nonce, t.turnId, now())).turnId,
    t.turnId,
  );
});
test('runtime SQL R13: enabled missing global/schema fails closed, disabled remains compatible without erasing controls', async () => {
  const s = await seed(),
    t = await authoring.enqueueDraftExpand(writing(s));
  await command(scope(s));
  assert.equal(
    (await new MySqlRuntimeExecutionControlRepository(database, false).read(scope(s))).enabled,
    false,
  );
  await assert.rejects(
    new MySqlRuntimeExecutionControlRepository(database, false).change({}),
    (e) => e.code === 'DISABLED',
  );
  const c = await database.openConnection();
  await c.query('RENAME TABLE runtime_execution_control TO runtime_execution_control_saved');
  try {
    assert.equal(await controls.probe(), false);
    await assert.rejects(
      attempts.markDispatch({ merchantId: s.merchantId, operation: 'writing' }, now()),
    );
    await assert.rejects(claim(s));
    assert.equal((await authoring.get(s, t.taskId)).taskId, t.taskId);
  } finally {
    await c.query('RENAME TABLE runtime_execution_control_saved TO runtime_execution_control');
    await c.end();
  }
  await sql("DELETE FROM runtime_execution_control WHERE scope_key='global'");
  try {
    assert.equal(await controls.probe(), false);
    await assert.rejects(
      attempts.markDispatch({ merchantId: s.merchantId, operation: 'preview' }, now()),
    );
  } finally {
    await sql(
      "INSERT INTO runtime_execution_control(scope_key,scope_type,state,revision) VALUES('global','global','active',0)",
    );
  }
});
test('runtime SQL R14: observation exposes metadata only, bounded pagination, reservation stock and honest timing exclusions', async () => {
  const s = await seed();
  await entitlement(s);
  const a = await authoring.enqueueDraftExpand(writing(s)),
    b = await authoring.enqueueDraftExpand(writing(s)),
    c = await claim(s),
    r = await dispatch(c);
  await attempts.recordOutcome(r.attemptId, 'succeeded', now());
  await authoring.complete(c, { options: ['合成零售', '合成商品零售'], reminders: [] }, now());
  const obs = new MySqlRuntimeObservationRepository(database),
    q = {
      merchantId: s.merchantId,
      from: new Date(Date.now() - 60000),
      to: new Date(Date.now() + 60000),
      limit: 1,
    },
    first = await obs.read(q),
    second = await obs.read({ ...q, cursor: first.nextCursor });
  assert.equal(first.sampleCount, 2);
  assert.equal(first.reservations.reservedCalls, 1);
  assert.equal(first.reservations.unit, 'call_reservations_not_money');
  assert.equal(first.tasks.length, 1);
  assert.notEqual(first.tasks[0].jobId, second.tasks[0].jobId);
  assert.equal(first.timings.acceptedToCompletedMs.sampleCount, 1);
  assert.equal(first.timings.acceptedToCompletedMs.excludedCount, 1);
  assert.equal(first.timings.acceptedToDispatchRecordMs.sampleCount, 1);
  assert.ok(!JSON.stringify(first).includes('家居'));
  assert.ok(!('payload' in first.tasks[0]));
  await assert.rejects(obs.read({ ...q, limit: 101 }), (e) => e.code === 'INVALID_REQUEST');
  await assert.rejects(
    obs.read({ ...q, to: new Date(Date.now() + 40 * 86400000) }),
    (e) => e.code === 'INVALID_REQUEST',
  );
  assert.equal(new Set([a.taskId, b.taskId]).size, 2);
});

test('runtime SQL R15: migration/unknown receipts are excluded from dispatch timing and exact synthetic times remain attributable', async () => {
  const s = await seed(),
    stamp = Date.now();
  async function completeOne() {
    await authoring.enqueueDraftExpand(writing(s));
    const c = await claim(s),
      r = await dispatch(c);
    await attempts.recordOutcome(r.attemptId, 'succeeded', now());
    await authoring.complete(c, { options: ['合成业务', '合成零售'], reminders: [] }, now());
    return { c, r };
  }
  const known = await completeOne();
  await sql('UPDATE job SET created_at=?,completed_at=? WHERE id=UNHEX(?)', [
    new Date(stamp - 5000),
    new Date(stamp - 1000),
    known.c.jobId,
  ]);
  await sql('UPDATE model_call_attempt SET created_at=? WHERE id=UNHEX(?)', [
    new Date(stamp - 3000),
    known.r.attemptId,
  ]);
  const migrated = await completeOne();
  await sql('UPDATE model_call_attempt SET claim_generation=0 WHERE id=UNHEX(?)', [
    migrated.r.attemptId,
  ]);
  await authoring.enqueueDraftExpand(writing(s));
  const unknown = await claim(s),
    r = await dispatch(unknown);
  await attempts.recordOutcome(r.attemptId, 'unknown', now());
  await authoring.fail(unknown, 'MODEL_RESULT_UNKNOWN', now());
  const result = await new MySqlRuntimeObservationRepository(database).read({
    merchantId: s.merchantId,
    from: new Date(stamp - 60000),
    to: new Date(stamp + 60000),
  });
  assert.equal(result.timings.acceptedToCompletedMs.sampleCount, 2);
  assert.equal(result.timings.acceptedToCompletedMs.excludedCount, 1);
  assert.equal(result.timings.acceptedToDispatchRecordMs.sampleCount, 1);
  assert.equal(result.timings.acceptedToDispatchRecordMs.p50Ms, 2000);
  assert.equal(result.timings.acceptedToDispatchRecordMs.excludedCount, 2);
  assert.equal(result.receipts.unresolvedRiskCount, 1);
  assert.equal(result.reservations.allocatedMerchantCount, 0);
});

test('runtime SQL R16: observation caps timing samples and scope/job request shape cannot accept forged merchant selectors', async () => {
  const s = await seed(),
    values = [],
    args = [];
  for (let i = 0; i < 1001; i++) {
    values.push(
      "(UNHEX(?),UNHEX(?),'draft.expand',UNHEX(?),'{}','pending',0,0,5,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",
    );
    args.push(fresh(), s.merchantId, fresh() + fresh());
  }
  await sql(
    `INSERT INTO job(id,merchant_id,type,dedup_key,payload,state,priority,attempt,max_attempts,run_after,created_at,updated_at) VALUES ${values.join(',')}`,
    args,
  );
  const result = await new MySqlRuntimeObservationRepository(database).read({
    merchantId: s.merchantId,
    from: new Date(Date.now() - 60000),
    to: new Date(Date.now() + 60000),
    limit: 100,
  });
  assert.equal(result.tasks.length, 100);
  assert.equal(result.sampleCount, 1001);
  assert.equal(result.timings.acceptedToCompletedMs.examinedCount, 1000);
  assert.equal(result.timings.acceptedToCompletedMs.truncated, true);
  assert.equal(result.timings.acceptedToCompletedMs.sampleCount, 0);
  await assert.rejects(
    controls.change({
      scope: { kind: 'job', jobId: result.tasks[0].jobId, merchantId: fresh() },
      action: 'pause',
      expectedRevision: '0',
      requestId: 'runtime_' + fresh(),
      reason: '合成非法作用域',
      confirmed: true,
      operatorId: 'synthetic_ops',
      now: now(),
    }),
    (e) => e.code === 'INVALID_REQUEST',
  );
});
