import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import {
  MySqlKnowledgeOrganizationRepository,
  MySqlAssistantLifecycleRepository,
} from '../dist/index.js';
import {
  database,
  lifecycle,
  materials,
  jobs,
  attempts,
  sql,
  seed,
  request,
  accepted,
  claim,
  expire,
  complete,
  apply,
  draft,
  fresh,
  publicSessions,
  signingSecret,
  entitlement,
} from './knowledge-stage2-fixtures.mjs';

// Module-level preflight fails before ANY test is registered or allowed to write.
assert.equal(
  (await sql('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE()'))[0]
    .n,
  0,
  'requires a new empty dedicated database',
);

test('stage2 MySQL: additive result migration preserves baseline rows, release pointer and old public reader', async () => {
  const c = await database.openConnection();
  try {
    assert.equal(
      (
        await c.query(
          'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE()',
        )
      )[0][0].n,
      0,
      'requires a new empty dedicated database',
    );
    await migrate(drizzle({ client: c }), {
      migrationsFolder: process.env.H5CS_STAGE2_BASELINE_MIGRATIONS,
    });
  } finally {
    await c.end();
  }
  const s = await seed(),
    nonce = Buffer.from('synthetic-old-reader-nonce-fixed-32')
      .subarray(0, 32)
      .toString('base64url');
  // Enabling the feature against the old schema must stop before admission or
  // any ticking lease, including when the queue is empty.
  await assert.rejects(jobs.enqueue(request(s)), (e) => e.code === 'UNAVAILABLE');
  await assert.rejects(jobs.listRunnableMerchantHeads(new Date()), (e) => e.code === 'UNAVAILABLE');
  await assert.rejects(claim(s), (e) => e.code === 'UNAVAILABLE');
  assert.equal((await sql("SELECT COUNT(*) n FROM job WHERE type='knowledge.organize'"))[0].n, 0);
  const session = await publicSessions.createSession({
    publicSlug: s.publicSlug,
    sessionRequestId: 'session_request_' + fresh(),
    visitorNonce: nonce,
    now: new Date(),
  });
  await publicSessions.acceptTurn({
    sessionHandle: session.sessionHandle,
    visitorNonce: nonce,
    clientMessageId: 'message_' + fresh(),
    content: '旧版本合成问题',
    now: new Date(),
  });
  const before = await sql(
    'SELECT LOWER(HEX(id)) id,public_slug,LOWER(HEX(active_release_id)) releaseId,draft_revision FROM assistant',
  );
  const counts = await sql(
    'SELECT (SELECT COUNT(*) FROM message) messages,(SELECT COUNT(*) FROM job) jobs',
  );
  const connection = await database.openConnection();
  try {
    await migrate(drizzle({ client: connection }), {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
  } finally {
    await connection.end();
  }
  assert.deepEqual(
    await sql(
      'SELECT LOWER(HEX(id)) id,public_slug,LOWER(HEX(active_release_id)) releaseId,draft_revision FROM assistant',
    ),
    before,
  );
  assert.deepEqual(
    await sql('SELECT (SELECT COUNT(*) FROM message) messages,(SELECT COUNT(*) FROM job) jobs'),
    counts,
  );
  assert.equal(
    (
      await sql(
        "SELECT COUNT(*) n FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='job' AND COLUMN_NAME='result'",
      )
    )[0].n,
    1,
  );
  const { MySqlPublicSessionRepository } = await import(
    pathToFileURL(process.env.H5CS_STAGE2_LEGACY_READER)
  );
  const oldReader = new MySqlPublicSessionRepository(database, signingSecret);
  const history = await oldReader.readHistory(session.sessionHandle, nonce, new Date());
  assert.equal(history.messages[0].content, '旧版本合成问题');
  assert.equal(history.releaseRef, s.releaseId);
});
test('stage2 MySQL: concurrent same request is one job and conflicting replays reject', async () => {
  const s = await seed(),
    r = request(s),
    results = await Promise.all(Array.from({ length: 8 }, () => jobs.enqueue(r)));
  assert.equal(new Set(results.map((t) => t.taskId)).size, 1);
  assert.equal(
    (
      await sql(
        "SELECT COUNT(*) n FROM job WHERE merchant_id=UNHEX(?) AND type='knowledge.organize'",
        [s.merchantId],
      )
    )[0].n,
    1,
  );
  await assert.rejects(
    jobs.enqueue({ ...r, revision: 2 }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  await lifecycle.saveDraft({
    ...s,
    expectedRevision: 1,
    draft: { ...draft, materialsSummary: '人工新稿' },
    now: new Date(),
  });
  const replay = await jobs.enqueue(r);
  assert.equal(replay.taskId, results[0].taskId);
  assert.equal(replay.stale, true);
});
test('stage2 MySQL: tenant/actor/assistant checks reject task reads and mutations', async () => {
  const a = await seed(),
    b = await seed(),
    t = await accepted(a);
  for (const scope of [b, { ...a, userId: b.userId }, { ...a, assistantId: b.assistantId }]) {
    await assert.rejects(jobs.get(scope, t.taskId), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(jobs.cancel(scope, t.taskId, new Date()), (e) => e.code === 'NOT_FOUND');
  }
  assert.equal((await jobs.get(a, t.taskId)).state, 'queued');
});
test('stage2 MySQL: pre-dispatch restart advances generation and fences stale dispatch/completion', async () => {
  const s = await seed();
  const subject = await entitlement(s);
  await accepted(s);
  const first = await claim(s);
  await expire(first);
  await jobs.recoverExpired(new Date());
  const second = await claim(s);
  assert.equal(second.claimGeneration, '2');
  assert.equal(
    await jobs.complete(first, { summary: '旧答案', warnings: [] }, new Date()),
    'stale',
  );
  await assert.rejects(
    attempts.markDispatch(
      { merchantId: s.merchantId, operation: 'organize', knowledgeClaim: first },
      new Date(),
    ),
  );
  const r = await attempts.markDispatch(
    { merchantId: s.merchantId, operation: 'organize', knowledgeClaim: second },
    new Date(),
  );
  await assert.rejects(
    attempts.markDispatch(
      { merchantId: s.merchantId, operation: 'organize', knowledgeClaim: second },
      new Date(),
    ),
  );
  await attempts.recordOutcome(r.attemptId, 'succeeded', new Date(), 'synthetic-recovered');
  assert.equal(
    await jobs.complete(second, { summary: '毛巾29元', warnings: [] }, new Date()),
    'applied',
  );
  assert.equal(
    (
      await sql('SELECT COUNT(*) n FROM model_call_attempt WHERE merchant_id=UNHEX(?)', [
        s.merchantId,
      ])
    )[0].n,
    1,
  );
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
});
test('stage2 MySQL: pending input drift and archived sources fail before dispatch', async () => {
  for (const kind of ['draft', 'archive']) {
    const s = await seed(),
      t = await accepted(s);
    if (kind === 'draft')
      await lifecycle.saveDraft({
        ...s,
        expectedRevision: 1,
        draft: { ...draft, materialsSummary: '新输入' },
        now: new Date(),
      });
    else await materials.archive({ ...s, sourceId: s.sourceId });
    assert.equal(await claim(s), null);
    const status = await jobs.get(s, t.taskId);
    assert.equal(status.state, 'failed');
    assert.equal(status.stale, true);
    assert.equal(
      (
        await sql('SELECT COUNT(*) n FROM model_call_attempt WHERE merchant_id=UNHEX(?)', [
          s.merchantId,
        ])
      )[0].n,
      0,
    );
  }
});
test('stage2 MySQL: after-dispatch restart becomes unknown and never retries automatically', async () => {
  const s = await seed(),
    t = await accepted(s),
    c = await claim(s),
    r = await attempts.markDispatch(
      { merchantId: s.merchantId, operation: 'organize', knowledgeClaim: c },
      new Date(),
    );
  await expire(c);
  await jobs.recoverExpired(new Date());
  assert.equal(await claim(s), null);
  const status = await jobs.get(s, t.taskId);
  assert.equal(status.error.code, 'MODEL_RESULT_UNKNOWN');
  assert.equal(status.canRetry, false);
  await assert.rejects(
    jobs.retry(s, t.taskId, 'organize_' + fresh(), new Date()),
    (e) => e.code === 'RETRY_UNSAFE',
  );
  await attempts.recordOutcome(r.attemptId, 'succeeded', new Date(), 'synthetic-late-known');
  assert.equal((await jobs.get(s, t.taskId)).state, 'failed');
  assert.equal(await jobs.complete(c, { summary: '迟到', warnings: [] }, new Date()), 'stale');
});
test('stage2 MySQL: safe explicit retry creates a distinct job and retry request replay reuses it', async () => {
  const s = await seed(),
    t = await accepted(s),
    c = await claim(s);
  await jobs.fail(c, 'MODEL_UNAVAILABLE', new Date());
  const key = 'organize_' + fresh(),
    next = await jobs.retry(s, t.taskId, key, new Date());
  assert.notEqual(next.taskId, t.taskId);
  assert.equal((await jobs.retry(s, t.taskId, key, new Date())).taskId, next.taskId);
  assert.equal((await jobs.get(s, t.taskId)).state, 'failed');
});
test('stage2 MySQL: queued cancel costs nothing and cancel-vs-dispatch never admits late output', async () => {
  const queued = await seed(),
    q = await accepted(queued);
  await jobs.cancel(queued, q.taskId, new Date());
  assert.equal(await claim(queued), null);
  assert.equal(
    (
      await sql('SELECT COUNT(*) n FROM model_call_attempt WHERE merchant_id=UNHEX(?)', [
        queued.merchantId,
      ])
    )[0].n,
    0,
  );
  const s = await seed(),
    t = await accepted(s),
    c = await claim(s);
  const [cancel, dispatch] = await Promise.allSettled([
    jobs.cancel(s, t.taskId, new Date()),
    attempts.markDispatch(
      { merchantId: s.merchantId, operation: 'organize', knowledgeClaim: c },
      new Date(),
    ),
  ]);
  assert.equal(cancel.status, 'fulfilled');
  if (dispatch.status === 'fulfilled')
    await attempts.recordOutcome(
      dispatch.value.attemptId,
      'succeeded',
      new Date(),
      'synthetic-cancel-late',
    );
  assert.equal(await jobs.complete(c, { summary: '迟到答案', warnings: [] }, new Date()), 'stale');
  assert.equal((await jobs.get(s, t.taskId)).state, 'cancelled');
  assert.equal((await jobs.get(s, t.taskId)).canApply, false);
});
test('stage2 MySQL: adoption CAS is idempotent and leaves fixed slug and published release intact', async () => {
  const s = await seed(),
    { task } = await complete(s),
    first = await apply(s, task);
  assert.equal(first.revision, 2);
  assert.deepEqual(await apply(s, task), first);
  await assert.rejects(
    apply(s, task, { summary: '另一份内容' }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  const snapshot = await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId);
  assert.equal(snapshot.publicSlug, s.publicSlug);
  assert.equal(snapshot.activeReleaseId, s.releaseId);
  assert.equal(snapshot.draftRevision, 2);
  await lifecycle.saveDraft({
    ...s,
    expectedRevision: 2,
    draft: { ...draft, materialsSummary: '之后的人工修改' },
    now: new Date(),
  });
  assert.deepEqual(await apply(s, task), first);
  assert.equal(
    (await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId)).draft.materialsSummary,
    '之后的人工修改',
  );
});
test('stage2 MySQL: stale or deleted-source candidate cannot be applied even with newest revision', async () => {
  for (const kind of ['draft', 'archive']) {
    const s = await seed(),
      { task } = await complete(s);
    if (kind === 'draft')
      await lifecycle.saveDraft({
        ...s,
        expectedRevision: 1,
        draft: { ...draft, materialsSummary: '新版本内容' },
        now: new Date(),
      });
    else await materials.archive({ ...s, sourceId: s.sourceId });
    await assert.rejects(
      apply(s, task, { expectedRevision: kind === 'draft' ? 2 : 1 }),
      (e) => e.code === 'INPUT_CHANGED',
    );
    const status = await jobs.get(s, task.taskId);
    assert.equal(status.canApply, false);
    assert.equal(status.stale, true);
  }
});
test('stage2 MySQL: adoption racing with draft save has exactly one revision winner', async () => {
  const s = await seed(),
    { task } = await complete(s);
  const outcomes = await Promise.allSettled([
    apply(s, task),
    lifecycle.saveDraft({
      ...s,
      expectedRevision: 1,
      draft: { ...draft, materialsSummary: '并发人工稿' },
      now: new Date(),
    }),
  ]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(
    (await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId)).draftRevision,
    2,
  );
});
function commitLostConfig() {
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
                throw Error('synthetic lost COMMIT acknowledgement');
              }
            };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}
test('stage2 MySQL: lost enqueue COMMIT is recovered by original request identity without duplicate job', async () => {
  const s = await seed(),
    input = request(s),
    repo = new MySqlKnowledgeOrganizationRepository(commitLostConfig(), true);
  await assert.rejects(repo.enqueue(input), (e) => e.code === 'WRITE_OUTCOME_UNKNOWN');
  const recovered = await jobs.findByRequest(s, input.requestId);
  assert.ok(recovered);
  assert.equal((await jobs.enqueue(input)).taskId, recovered.taskId);
  assert.equal(
    (
      await sql(
        "SELECT COUNT(*) n FROM job WHERE merchant_id=UNHEX(?) AND type='knowledge.organize'",
        [s.merchantId],
      )
    )[0].n,
    1,
  );
});
test('stage2 MySQL: lost adoption COMMIT replays stored adoption receipt without a second draft write', async () => {
  const s = await seed(),
    { task } = await complete(s),
    lost = new MySqlAssistantLifecycleRepository(commitLostConfig());
  await assert.rejects(
    lost.applyKnowledgeOrganization({
      ...s,
      taskId: task.taskId,
      expectedRevision: 1,
      summary: '毛巾29元/条，运费需确认。',
      mode: 'replace',
      confirmed: true,
      now: new Date(),
    }),
  );
  assert.equal((await apply(s, task)).revision, 2);
  assert.equal(
    (await lifecycle.findManagementSnapshot(s.merchantId, s.assistantId)).draftRevision,
    2,
  );
});
test('stage2 MySQL: scope drift before dispatch cannot reserve fees', async () => {
  const s = await seed(),
    t = await accepted(s),
    c = await claim(s);
  await lifecycle.saveDraft({
    ...s,
    expectedRevision: 1,
    draft: { ...draft, materialsSummary: '新价格待核对' },
    now: new Date(),
  });
  await assert.rejects(
    attempts.markDispatch(
      { merchantId: s.merchantId, operation: 'organize', knowledgeClaim: c },
      new Date(),
    ),
  );
  assert.equal(
    (
      await sql('SELECT COUNT(*) n FROM model_call_attempt WHERE merchant_id=UNHEX(?)', [
        s.merchantId,
      ])
    )[0].n,
    0,
  );
  await jobs.fail(c, 'INPUT_CHANGED', new Date());
  assert.equal((await jobs.get(s, t.taskId)).canRetry, false);
});
test('stage2 MySQL: cancelled processing still records late supplier outcome without admitting candidate', async () => {
  const s = await seed(),
    t = await accepted(s),
    c = await claim(s),
    r = await attempts.markDispatch(
      { merchantId: s.merchantId, operation: 'organize', knowledgeClaim: c },
      new Date(),
    );
  await jobs.cancel(s, t.taskId, new Date());
  await attempts.recordOutcome(r.attemptId, 'succeeded', new Date(), 'synthetic-cancel-receipt');
  const status = await jobs.get(s, t.taskId);
  assert.equal(status.state, 'cancelled');
  assert.equal(status.modelOutcome, 'succeeded');
  assert.equal(status.canApply, false);
  assert.equal(await jobs.complete(c, { summary: '迟到', warnings: [] }, new Date()), 'stale');
  assert.equal(
    (
      await sql('SELECT COUNT(*) n FROM model_call_attempt WHERE merchant_id=UNHEX(?)', [
        s.merchantId,
      ])
    )[0].n,
    1,
  );
});
test('stage2 MySQL: changed source fingerprint prevents safe retry and malformed completion fails closed', async () => {
  const s = await seed(),
    t = await accepted(s),
    c = await claim(s);
  await jobs.fail(c, 'MODEL_UNAVAILABLE', new Date());
  await sql("UPDATE knowledge_source SET title='重命名的合成材料.txt' WHERE id=UNHEX(?)", [
    s.sourceId,
  ]);
  await assert.rejects(
    jobs.retry(s, t.taskId, 'organize_' + fresh(), new Date()),
    (e) => e.code === 'INPUT_CHANGED',
  );
  const other = await seed(),
    done = await complete(other);
  await sql('UPDATE job SET result=NULL WHERE id=UNHEX(?)', [done.task.taskId]);
  await assert.rejects(jobs.get(other, done.task.taskId), (e) => e.code === 'UNAVAILABLE');
  await assert.rejects(apply(other, done.task), (e) => e.code === 'TASK_NOT_READY');
});
