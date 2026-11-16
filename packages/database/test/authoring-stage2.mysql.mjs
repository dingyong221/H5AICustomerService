import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MySqlAuthoringTaskRepository,
  MySqlModelCallAttemptRepository,
  MySqlAssistantLifecycleRepository,
} from '../dist/index.js';
import {
  database,
  lifecycle,
  attempts,
  seed,
  sql,
  fresh,
  hash,
  draft,
  entitlement,
} from './knowledge-stage2-fixtures.mjs';
const repo = new MySqlAuthoringTaskRepository(database, { draftExpand: true, previewReply: true });
const now = () => new Date(),
  key = () => `authoring_${fresh()}`;
const writing = (s, patch = {}) => ({
  ...s,
  requestId: key(),
  revision: 1,
  field: 'industry',
  brief: '家居零售',
  currentText: ' 家居零售 \r\n',
  consent: true,
  now: now(),
  ...patch,
});
const preview = (s, patch = {}) => ({
  ...s,
  requestId: key(),
  revision: 1,
  question: '运费多少？',
  now: now(),
  ...patch,
});
const claim = (s, kind = 'draft.expand') =>
  repo.claimNext(now(), 'authoring_sql_owner', { merchantId: s.merchantId, kind });
const output = { options: ['家居用品零售', '家居日用品服务'], reminders: ['核对经营范围'] };
const dispatch = (c) =>
  attempts.markDispatch(
    {
      merchantId: c.merchantId,
      operation: c.payload.kind === 'draft.expand' ? 'writing' : 'preview',
      authoringClaim: c,
    },
    now(),
  );
async function successful(c) {
  const r = await dispatch(c);
  await attempts.recordOutcome(r.attemptId, 'succeeded', now(), 'synthetic-authoring-' + fresh());
  return r;
}
const getGov = (s) =>
  sql(
    'SELECT LOWER(HEX(preview_id)) checkId,preview_revision revision,preview_verdict verdict,preview_answer answer FROM assistant_publication_governance WHERE merchant_id=UNHEX(?) AND assistant_id=UNHEX(?)',
    [s.merchantId, s.assistantId],
  );
const expire = (c) =>
  sql('UPDATE job SET lease_until=DATE_SUB(UTC_TIMESTAMP(6),INTERVAL 1 SECOND) WHERE id=UNHEX(?)', [
    c.jobId,
  ]);
const count = (s) =>
  sql('SELECT COUNT(*) n FROM model_call_attempt WHERE merchant_id=UNHEX(?)', [s.merchantId]);
const snapshot = (s) => lifecycle.findManagementSnapshot(s.merchantId, s.assistantId);
const syncInput = (s, captured, answer = '合成同步回答') => ({
  ...s,
  expectedDraftRevision: captured.draftRevision,
  expectedPreviousPreviewId: captured.previousPreviewCheckId,
  question: '合成同步问题',
  answer,
  now: now(),
});
const revisionConflict = (e) => e?.name === 'AssistantRevisionConflictError';
const auditCount = (s) =>
  sql(
    "SELECT COUNT(*) n FROM audit_log WHERE merchant_id=UNHEX(?) AND action='assistant.preview_recorded'",
    [s.merchantId],
  );
assert.equal(
  (
    await sql(
      "SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='job' AND column_name='result'",
    )
  )[0].n,
  1,
  'Run after the isolated stage2 migration suite',
);

test('authoring SQL: raw field hash, one quota reservation, candidate replay never saves a draft', async () => {
  const s = await seed(),
    subject = await entitlement(s),
    input = writing(s),
    t = await repo.enqueueDraftExpand(input),
    c = await claim(s);
  assert.equal(t.inputFieldHash, hash(input.currentText));
  await successful(c);
  await assert.rejects(dispatch(c));
  await repo.complete(c, output, now());
  const done = await repo.get(s, t.taskId);
  assert.equal(done.canUse, true);
  assert.equal((await repo.enqueueDraftExpand(input)).taskId, t.taskId);
  const snapshot = await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId);
  assert.equal(snapshot.draftRevision, 1);
  assert.equal(snapshot.publicSlug, s.publicSlug);
  assert.equal(snapshot.activeReleaseId, s.releaseId);
  assert.equal(snapshot.draft.industry, draft.industry);
  assert.equal((await count(s))[0].n, 1);
  assert.equal(
    (
      await sql(
        'SELECT model_calls_reserved n FROM marketplace_entitlement WHERE subject_digest=?',
        [subject],
      )
    )[0].n,
    1,
  );
  assert.equal(
    (
      await sql('SELECT COUNT(*) n FROM marketplace_model_attempt WHERE subject_digest=?', [
        subject,
      ])
    )[0].n,
    1,
  );
  await assert.rejects(
    repo.enqueueDraftExpand({ ...input, currentText: '冲突' }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
});
test('authoring SQL: concurrent admission is bounded at four and same-request replay bypasses the full queue', async () => {
  const s = await seed(),
    requests = Array.from({ length: 8 }, () => writing(s)),
    settled = await Promise.allSettled(requests.map((x) => repo.enqueueDraftExpand(x)));
  assert.equal(settled.filter((x) => x.status === 'fulfilled').length, 4);
  for (const r of settled.filter((x) => x.status === 'rejected'))
    assert.equal(r.reason.code, 'QUEUE_FULL');
  const i = settled.findIndex((x) => x.status === 'fulfilled');
  assert.equal((await repo.enqueueDraftExpand(requests[i])).taskId, settled[i].value.taskId);
  await assert.rejects(repo.enqueuePreviewReply(preview(s)), (e) => e.code === 'QUEUE_FULL');
  assert.equal((await count(s))[0].n, 0);
});
test('authoring SQL: same request identity is scoped by type, tenant and actor; forged claims never reserve', async () => {
  const a = await seed(),
    b = await seed(),
    requestId = key(),
    d = await repo.enqueueDraftExpand(writing(a, { requestId })),
    p = await repo.enqueuePreviewReply(preview(a, { requestId }));
  assert.notEqual(d.taskId, p.taskId);
  assert.equal((await repo.findByRequest(a, 'draft.expand', requestId)).taskId, d.taskId);
  for (const scope of [b, { ...a, userId: b.userId }, { ...a, assistantId: b.assistantId }]) {
    await assert.rejects(repo.get(scope, d.taskId), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(repo.cancel(scope, d.taskId, now()), (e) => e.code === 'NOT_FOUND');
  }
  const dc = await claim(a),
    pc = await claim(a, 'preview.reply');
  await assert.rejects(dispatch({ ...dc, jobId: pc.jobId }));
  await assert.rejects(
    attempts.markDispatch(
      { merchantId: a.merchantId, operation: 'preview', authoringClaim: dc },
      now(),
    ),
  );
  assert.equal((await count(a))[0].n, 0);
});
test('authoring SQL: pre-dispatch recovery advances generation and fences every old writer', async () => {
  const s = await seed();
  await repo.enqueueDraftExpand(writing(s));
  const old = await claim(s);
  await expire(old);
  await repo.recoverExpired(now());
  const freshClaim = await claim(s);
  assert.equal(freshClaim.claimGeneration, '2');
  await assert.rejects(dispatch(old));
  assert.equal(await repo.complete(old, output, now()), 'stale');
  assert.equal(await repo.fail(old, 'MODEL_UNAVAILABLE', now()), 'stale');
  await successful(freshClaim);
  assert.equal(await repo.complete(freshClaim, output, now()), 'applied');
  assert.equal((await count(s))[0].n, 1);
});
test('authoring SQL: post-dispatch expiry remains unknown with no automatic or explicit retry', async () => {
  const s = await seed(),
    t = await repo.enqueueDraftExpand(writing(s)),
    c = await claim(s);
  await dispatch(c);
  await expire(c);
  await repo.recoverExpired(now());
  assert.equal(await claim(s), null);
  assert.equal((await repo.get(s, t.taskId)).canRetry, false);
  await assert.rejects(repo.retry(s, t.taskId, key(), now()), (e) => e.code === 'RETRY_UNSAFE');
  assert.equal((await count(s))[0].n, 1);
});
test('authoring SQL: queued cancellation is free and late supplier success does not revive cancelled work', async () => {
  const s = await seed(),
    q = await repo.enqueueDraftExpand(writing(s));
  await repo.cancel(s, q.taskId, now());
  assert.equal(await claim(s), null);
  assert.equal((await count(s))[0].n, 0);
  const p = await repo.enqueuePreviewReply(preview(s)),
    c = await claim(s, 'preview.reply'),
    before = await getGov(s),
    r = await dispatch(c);
  await repo.cancel(s, p.taskId, now());
  await attempts.recordOutcome(r.attemptId, 'succeeded', now(), 'synthetic-late-cancel');
  assert.equal(await repo.complete(c, { answer: '运费需确认' }, now()), 'stale');
  const state = await repo.get(s, p.taskId);
  assert.equal(state.state, 'cancelled');
  assert.equal(state.modelOutcome, 'succeeded');
  assert.equal(state.canJudge, false);
  assert.deepEqual(await getGov(s), before);
});
test('authoring SQL: changed draft blocks dispatch and previously completed candidates become stale', async () => {
  for (const afterComplete of [false, true]) {
    const s = await seed(),
      t = await repo.enqueueDraftExpand(writing(s)),
      c = await claim(s);
    if (afterComplete) {
      await successful(c);
      await repo.complete(c, output, now());
    }
    await lifecycle.saveDraft({
      ...s,
      expectedRevision: 1,
      draft: { ...draft, industry: '人工改稿' },
      now: now(),
    });
    if (!afterComplete) await assert.rejects(dispatch(c));
    const state = await repo.get(s, t.taskId);
    assert.equal(state.stale, true);
    assert.equal(state.canUse, false);
    assert.equal(state.canRetry, false);
    assert.equal((await count(s))[0].n, afterComplete ? 1 : 0);
  }
});
test('authoring SQL: safe retry is a distinct job, replay idempotent, and revision drift denies new retry', async () => {
  const s = await seed(),
    t = await repo.enqueueDraftExpand(writing(s)),
    c = await claim(s);
  await repo.fail(c, 'MODEL_UNAVAILABLE', now());
  const requestId = key(),
    retried = await repo.retry(s, t.taskId, requestId, now());
  assert.notEqual(retried.taskId, t.taskId);
  assert.equal((await repo.retry(s, t.taskId, requestId, now())).taskId, retried.taskId);
  await lifecycle.saveDraft({
    ...s,
    expectedRevision: 1,
    draft: { ...draft, industry: '新输入' },
    now: now(),
  });
  assert.equal((await repo.retry(s, t.taskId, requestId, now())).taskId, retried.taskId);
  await assert.rejects(repo.retry(s, t.taskId, key(), now()), (e) => e.code === 'INPUT_CHANGED');
});
test('authoring SQL: preview uses persisted facts and saves one pending check with exact evidence atomically', async () => {
  const s = await seed(),
    input = preview(s),
    t = await repo.enqueuePreviewReply(input),
    c = await claim(s, 'preview.reply');
  assert.equal(c.facts.draft.pricingSummary, draft.pricingSummary);
  await assert.rejects(
    dispatch({
      ...c,
      facts: { ...c.facts, draft: { ...c.facts.draft, pricingSummary: '伪造1元' } },
    }),
  );
  await successful(c);
  await repo.complete(c, { answer: '毛巾29元，运费需商家确认。' }, now());
  const done = await repo.get(s, t.taskId),
    gov = (await getGov(s))[0];
  assert.equal(done.canJudge, true);
  assert.equal(done.result.checkId, gov.checkId);
  assert.equal(gov.verdict, 'pending');
  assert.equal(
    done.result.evidence.find((x) => x.label === '价格与适用条件').text,
    draft.pricingSummary,
  );
  assert.equal(await repo.complete(c, { answer: '重复' }, now()), 'stale');
  assert.equal((await getGov(s))[0].checkId, gov.checkId);
  assert.equal((await repo.enqueuePreviewReply(input)).taskId, t.taskId);
  assert.equal((await repo.cancel(s, t.taskId, now())).state, 'completed');
});
test('authoring SQL: canonical and reordered JSON both reach human judgement and publication through lifecycle', async () => {
  for (const reverse of [false, true]) {
    const s = await seed();
    const updated = { ...draft, businessScope: '跨层异步试聊与发布回归' };
    await lifecycle.saveDraft({ ...s, expectedRevision: 1, draft: updated, now: now() });
    await lifecycle.confirmDraftKnowledge({ ...s, expectedDraftRevision: 2, now: now() });
    const stored = reverse ? Object.fromEntries(Object.entries(updated).reverse()) : updated;
    await sql(
      'UPDATE assistant_draft SET config=? WHERE merchant_id=UNHEX(?) AND assistant_id=UNHEX(?)',
      [JSON.stringify(stored), s.merchantId, s.assistantId],
    );
    const task = await repo.enqueuePreviewReply(preview(s, { revision: 2 }));
    const c = await claim(s, 'preview.reply');
    await successful(c);
    assert.equal(await repo.complete(c, { answer: '毛巾29元，运费需确认。' }, now()), 'applied');
    const done = await repo.get(s, task.taskId);
    const governance = await lifecycle.getPublicationGovernance({ ...s, now: now() });
    assert.equal(done.canJudge, true);
    assert.equal(governance.quality.state, 'needs_review');
    assert.equal(governance.quality.checkId, done.result.checkId);
    await lifecycle.judgePreviewCheck({
      ...s,
      expectedDraftRevision: 2,
      checkId: done.result.checkId,
      verdict: 'pass',
      now: now(),
    });
    assert.equal(
      (await lifecycle.getPublicationGovernance({ ...s, now: now() })).quality.state,
      'passed',
    );
    await lifecycle.publish({
      ...s,
      expectedDraftRevision: 2,
      promptTemplateVersion: 'conversation-v1',
      retrievalPolicyVersion: 'confirmed-text-v1',
      modelPolicyVersion: 'local-no-model-v1',
      idempotency: {
        actorScopeDigest: Buffer.from(fresh() + fresh(), 'hex'),
        keyDigest: Buffer.from(fresh() + fresh(), 'hex'),
        requestHash: Buffer.from(fresh() + fresh(), 'hex'),
        expiresAt: new Date(Date.now() + 3600000),
      },
      now: now(),
    });
    const published = await snapshot(s);
    assert.equal(published.publicSlug, s.publicSlug);
    assert.notEqual(published.activeReleaseId, s.releaseId);
  }
});

test('authoring SQL: reversed async preview completion admits only one original-preview CAS winner', async () => {
  const s = await seed(),
    a = await repo.enqueuePreviewReply(preview(s, { question: '先发问题' })),
    b = await repo.enqueuePreviewReply(preview(s, { question: '后发问题' })),
    ca = await claim(s, 'preview.reply'),
    cb = await claim(s, 'preview.reply');
  await successful(ca);
  await successful(cb);
  await repo.complete(cb, { answer: '后完成者先写回' }, now());
  const winner = (await getGov(s))[0];
  await repo.complete(ca, { answer: '旧答案不可覆盖' }, now());
  assert.equal((await getGov(s))[0].checkId, winner.checkId);
  const states = await Promise.all([repo.get(s, a.taskId), repo.get(s, b.taskId)]);
  assert.equal(states.filter((t) => t.state === 'completed').length, 1);
  assert.equal(states.find((t) => t.state === 'failed').error.code, 'PREVIEW_SUPERSEDED');
});
test('authoring SQL: later synchronous preview supersedes an in-flight async answer', async () => {
  const s = await seed(),
    t = await repo.enqueuePreviewReply(preview(s)),
    c = await claim(s, 'preview.reply');
  const snapshot = await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId);
  await successful(c);
  const sync = await lifecycle.savePreviewCheck({
    ...s,
    expectedPreviousPreviewId: snapshot.previousPreviewCheckId,
    expectedDraftRevision: 1,
    question: '后来的同步试聊',
    answer: '同步答案',
    now: now(),
  });
  await repo.complete(c, { answer: '迟到异步答案' }, now());
  assert.equal((await getGov(s))[0].checkId, sync.checkId);
  assert.equal((await repo.get(s, t.taskId)).error.code, 'PREVIEW_SUPERSEDED');
});

test('preview CAS v2: late sync cannot replace an async completion captured from the same previous check', async () => {
  const s = await seed(),
    captured = await snapshot(s),
    input = syncInput(s, captured),
    t = await repo.enqueuePreviewReply(preview(s)),
    c = await claim(s, 'preview.reply');
  await successful(c);
  await repo.complete(c, { answer: '较晚发起先完成的异步回答' }, now());
  const winner = (await repo.get(s, t.taskId)).result.checkId,
    audit = await auditCount(s);
  await assert.rejects(lifecycle.savePreviewCheck(input), revisionConflict);
  assert.equal((await getGov(s))[0].checkId, winner);
  assert.equal((await repo.get(s, t.taskId)).canJudge, true);
  assert.equal((await getGov(s))[0].verdict, 'pending');
  assert.deepEqual(await auditCount(s), audit);
  assert.equal((await count(s))[0].n, 1);
});

test('preview CAS v2: reversed sync completion and simultaneous same-previous writers each admit only the first completion', async () => {
  const s = await seed(),
    captured = await snapshot(s),
    older = syncInput(s, captured, '旧同步回答'),
    newer = syncInput(s, await snapshot(s), '新同步回答');
  const winner = await lifecycle.savePreviewCheck(newer);
  await assert.rejects(lifecycle.savePreviewCheck(older), revisionConflict);
  assert.equal((await getGov(s))[0].checkId, winner.checkId);
  const next = await snapshot(s),
    before = await auditCount(s);
  const results = await Promise.allSettled([
    lifecycle.savePreviewCheck(syncInput(s, next, '并发一')),
    lifecycle.savePreviewCheck(syncInput(s, next, '并发二')),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(revisionConflict(results.find((r) => r.status === 'rejected').reason));
  assert.equal((await auditCount(s))[0].n, before[0].n + 1);
  assert.equal((await getGov(s))[0].verdict, 'pending');
});

test('preview CAS v2: missing or undefined previous ID fails closed while explicit empty snapshot allows one writer', async () => {
  const s = await seed();
  await sql(
    'DELETE FROM assistant_publication_governance WHERE merchant_id=UNHEX(?) AND assistant_id=UNHEX(?)',
    [s.merchantId, s.assistantId],
  );
  const captured = await snapshot(s);
  assert.equal(captured.previousPreviewCheckId, null);
  const input = syncInput(s, captured),
    missing = { ...input };
  delete missing.expectedPreviousPreviewId;
  const persistenceError = (e) => e?.name === 'AssistantLifecyclePersistenceError';
  await assert.rejects(lifecycle.savePreviewCheck(missing), persistenceError);
  await assert.rejects(
    lifecycle.savePreviewCheck({ ...input, expectedPreviousPreviewId: undefined }),
    persistenceError,
  );
  assert.deepEqual(await getGov(s), []);
  const winner = await lifecycle.savePreviewCheck(input);
  await assert.rejects(lifecycle.savePreviewCheck(input), revisionConflict);
  assert.equal((await getGov(s))[0].checkId, winner.checkId);
});

test('preview CAS v2: snapshot preserves raw previous ID when the displayed quality check belongs to an older revision', async () => {
  const s = await seed(),
    previous = await snapshot(s);
  await lifecycle.saveDraft({
    ...s,
    expectedRevision: 1,
    draft: { ...draft, businessScope: '修改后的合成范围' },
    now: now(),
  });
  const captured = await snapshot(s);
  assert.equal(captured.draftRevision, 2);
  assert.equal(captured.previousPreviewCheckId, previous.previousPreviewCheckId);
  const quality = (await lifecycle.getPublicationGovernance({ ...s, now: now() })).quality;
  assert.equal(quality.checkId, null);
  await assert.rejects(
    lifecycle.savePreviewCheck({ ...syncInput(s, captured), expectedPreviousPreviewId: null }),
    revisionConflict,
  );
  const saved = await lifecycle.savePreviewCheck(syncInput(s, captured));
  assert.equal((await getGov(s))[0].checkId, saved.checkId);
  assert.equal((await getGov(s))[0].verdict, 'pending');
});

test('preview CAS v2: lost sync COMMIT acknowledgement cannot mint a second check on replay or automatically pass judgment', async () => {
  const s = await seed(),
    captured = await snapshot(s),
    input = syncInput(s, captured),
    before = await auditCount(s);
  const fault = new MySqlAssistantLifecycleRepository(lostCommit());
  await assert.rejects(fault.savePreviewCheck(input), /synthetic lost COMMIT response/);
  const committed = (await getGov(s))[0];
  assert.notEqual(committed.checkId, captured.previousPreviewCheckId);
  assert.equal(committed.verdict, 'pending');
  await assert.rejects(lifecycle.savePreviewCheck(input), revisionConflict);
  assert.equal((await getGov(s))[0].checkId, committed.checkId);
  assert.equal((await auditCount(s))[0].n, before[0].n + 1);
  await assert.rejects(
    lifecycle.judgePreviewCheck({
      ...s,
      expectedDraftRevision: 1,
      checkId: captured.previousPreviewCheckId,
      verdict: 'pass',
      now: now(),
    }),
  );
  assert.equal((await getGov(s))[0].verdict, 'pending');
  await lifecycle.judgePreviewCheck({
    ...s,
    expectedDraftRevision: 1,
    checkId: committed.checkId,
    verdict: 'pass',
    now: now(),
  });
  assert.equal((await getGov(s))[0].verdict, 'pass');
});

test('preview CAS v2: failure before sync COMMIT rolls back check and audit then permits the original snapshot retry', async () => {
  const s = await seed(),
    captured = await snapshot(s),
    input = syncInput(s, captured),
    before = await auditCount(s);
  const fault = new MySqlAssistantLifecycleRepository({
    ...database,
    openConnection: async () => {
      const c = await database.openConnection();
      c.commit = async () => {
        throw Error('synthetic failure before COMMIT');
      };
      return c;
    },
  });
  await assert.rejects(fault.savePreviewCheck(input), /synthetic failure before COMMIT/);
  assert.equal((await getGov(s))[0].checkId, captured.previousPreviewCheckId);
  assert.deepEqual(await auditCount(s), before);
  const saved = await lifecycle.savePreviewCheck(input);
  assert.equal((await getGov(s))[0].checkId, saved.checkId);
  assert.equal((await getGov(s))[0].verdict, 'pending');
});
function injectingConfig(action) {
  return {
    ...database,
    openConnection: async () => {
      const c = await database.openConnection();
      return new Proxy(c, {
        get(target, key) {
          if (key === 'execute')
            return async (statement, params) => {
              await action(statement, params);
              return target.execute(statement, params);
            };
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
}
test('authoring SQL: failure between governance write and task completion rolls back both records and audit', async () => {
  const s = await seed(),
    t = await repo.enqueuePreviewReply(preview(s)),
    c = await claim(s, 'preview.reply');
  await successful(c);
  const before = await getGov(s),
    audits = await sql(
      "SELECT COUNT(*) n FROM audit_log WHERE merchant_id=UNHEX(?) AND action='assistant.preview_recorded'",
      [s.merchantId],
    );
  const fault = new MySqlAuthoringTaskRepository(
    injectingConfig((statement) => {
      if (statement.startsWith("UPDATE job SET state='completed'"))
        throw Error('synthetic write failure');
    }),
    { draftExpand: true, previewReply: true },
  );
  await assert.rejects(fault.complete(c, { answer: '不能半写入' }, now()));
  assert.deepEqual(await getGov(s), before);
  assert.equal((await repo.get(s, t.taskId)).state, 'processing');
  assert.deepEqual(
    await sql(
      "SELECT COUNT(*) n FROM audit_log WHERE merchant_id=UNHEX(?) AND action='assistant.preview_recorded'",
      [s.merchantId],
    ),
    audits,
  );
  await repo.complete(c, { answer: '明确本地结果可再持久化' }, now());
  assert.equal((await repo.get(s, t.taskId)).canJudge, true);
});
function lostCommit() {
  let lose = true;
  return {
    ...database,
    openConnection: async () => {
      const c = await database.openConnection();
      return new Proxy(c, {
        get(target, key) {
          if (key === 'commit')
            return async () => {
              await target.commit();
              if (lose) {
                lose = false;
                throw Error('synthetic lost COMMIT response');
              }
            };
          const v = target[key];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  };
}
test('authoring SQL: lost enqueue and preview-finalize COMMIT acknowledgements recover by original identities', async () => {
  const s = await seed(),
    input = preview(s),
    lost = new MySqlAuthoringTaskRepository(lostCommit(), { previewReply: true });
  await assert.rejects(lost.enqueuePreviewReply(input), (e) => e.code === 'WRITE_OUTCOME_UNKNOWN');
  const t = await repo.findByRequest(s, 'preview.reply', input.requestId);
  assert.ok(t);
  assert.equal((await repo.enqueuePreviewReply(input)).taskId, t.taskId);
  const c = await claim(s, 'preview.reply');
  await successful(c);
  const finalizer = new MySqlAuthoringTaskRepository(lostCommit(), { previewReply: true });
  await assert.rejects(
    finalizer.complete(c, { answer: '事务已完成但回执丢失' }, now()),
    (e) => e.code === 'WRITE_OUTCOME_UNKNOWN',
  );
  const done = await repo.get(s, t.taskId);
  assert.equal(done.state, 'completed');
  assert.equal(done.result.checkId, (await getGov(s))[0].checkId);
  assert.equal(await repo.complete(c, { answer: '不得再覆盖' }, now()), 'stale');
  assert.equal((await count(s))[0].n, 1);
});
test('authoring SQL: simultaneous completion serializes management/job/governance and old human verdict is rejected', async () => {
  const s = await seed(),
    old = (await getGov(s))[0],
    a = await repo.enqueuePreviewReply(preview(s)),
    b = await repo.enqueuePreviewReply(preview(s)),
    ca = await claim(s, 'preview.reply'),
    cb = await claim(s, 'preview.reply');
  await successful(ca);
  await successful(cb);
  await Promise.all([
    repo.complete(ca, { answer: '答案A' }, now()),
    repo.complete(cb, { answer: '答案B' }, now()),
  ]);
  const tasks = await Promise.all([repo.get(s, a.taskId), repo.get(s, b.taskId)]);
  assert.equal(tasks.filter((x) => x.canJudge).length, 1);
  await assert.rejects(
    lifecycle.judgePreviewCheck({
      ...s,
      expectedDraftRevision: 1,
      checkId: old.checkId,
      verdict: 'pass',
      now: now(),
    }),
  );
  assert.equal((await getGov(s))[0].verdict, 'pending');
});
test('authoring SQL: disabled feature preserves scoped reading/cancellation and pending input supersession is free', async () => {
  const s = await seed(),
    t = await repo.enqueuePreviewReply(preview(s)),
    disabled = new MySqlAuthoringTaskRepository(database, {
      draftExpand: false,
      previewReply: false,
    });
  assert.equal((await disabled.get(s, t.taskId)).state, 'queued');
  await lifecycle.savePreviewCheck({
    ...s,
    expectedPreviousPreviewId: (await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId))
      .previousPreviewCheckId,
    expectedDraftRevision: 1,
    question: '新记录',
    answer: '新答案',
    now: now(),
  });
  assert.equal(await claim(s, 'preview.reply'), null);
  assert.equal((await repo.get(s, t.taskId)).error.code, 'PREVIEW_SUPERSEDED');
  assert.equal((await count(s))[0].n, 0);
  assert.equal((await disabled.cancel(s, t.taskId, now())).state, 'cancelled');
});
test('authoring SQL: type-aware cursor never skips the second capability at a merchant page boundary', async () => {
  const s = await seed();
  await repo.enqueueDraftExpand(writing(s));
  await repo.enqueuePreviewReply(preview(s));
  let cursor,
    seen = [];
  for (let i = 0; i < 150; i++) {
    const heads = await repo.listRunnableMerchantHeads(now(), {
      limit: 1,
      ...(cursor ? { afterKey: cursor } : {}),
    });
    if (!heads.length) break;
    const h = heads[0];
    seen.push(`${h.merchantId}:${h.kind}`);
    cursor = seen.at(-1);
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(seen.includes(`${s.merchantId}:draft.expand`));
  assert.ok(seen.includes(`${s.merchantId}:preview.reply`));
});
test('authoring SQL: unknown handler and revoked membership fail closed before any supplier reservation', async () => {
  const s = await seed(),
    t = await repo.enqueueDraftExpand(writing(s));
  await sql(
    "UPDATE job SET payload=JSON_SET(payload,'$.handlerVersion','future-unsupported') WHERE id=UNHEX(?)",
    [t.taskId],
  );
  assert.equal(await claim(s), null);
  assert.equal((await count(s))[0].n, 0);
  const other = await seed();
  await repo.enqueueDraftExpand(writing(other));
  const c = await claim(other);
  await sql("UPDATE merchant_membership SET status='inactive' WHERE merchant_id=UNHEX(?)", [
    other.merchantId,
  ]);
  await assert.rejects(dispatch(c));
  assert.equal((await count(other))[0].n, 0);
});
