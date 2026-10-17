import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Connection, ExecuteValues, RowDataPacket } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import {
  loadDatabaseConfig,
  MySqlAssistantImprovementRepository,
  MySqlAssistantLifecycleRepository,
  MySqlMerchantAccessRepository,
  MySqlPlatformProvisioningRepository,
  MySqlPublicSessionRepository,
  type DatabaseConnectionConfig,
} from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId } from '@h5cs/domain';

// Negative transaction/constraint coverage, never a model-quality or live-merchant test.
// This independent guard intentionally does not import another executing integration suite.
const integrationUrl = process.env['H5CS_INTEGRATION_MYSQL_URL'];
if (!integrationUrl) throw new Error('Dedicated loopback integration database required');
const target = new URL(integrationUrl);
if (
  target.protocol !== 'mysql:' ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  target.pathname !== '/h5cs_integration_ci' ||
  target.username !== 'h5cs_ci' ||
  target.search ||
  target.hash
)
  throw new Error('Isolation tests may only use the dedicated loopback CI database');
const config = loadDatabaseConfig({
  MYSQL_DATABASE_URL: integrationUrl,
  NODE_ENV: 'test',
  APP_ENV: 'test',
});
if (!config.configured) throw new Error('Dedicated integration database unavailable');
const database = config.config;
const policy = { promptTemplateVersion: 'isolation-v1', modelPolicyVersion: 'isolation-v1' };
const lifecycle = new MySqlAssistantLifecycleRepository(database);
const improvements = new MySqlAssistantImprovementRepository(database, policy);
const idBytes = (value: string) => Buffer.from(value, 'hex');
const idem = () => ({
  actorScopeDigest: randomBytes(32),
  keyDigest: randomBytes(32),
  requestHash: randomBytes(32),
  expiresAt: new Date(Date.now() + 3_600_000),
});
const write = <T extends object>(input: T) => ({
  ...input,
  requestKey: randomUUID(),
  now: new Date(),
});

async function queryRows(
  sql: string,
  values: readonly (string | number | Buffer | Uint8Array | Date | null)[] = [],
) {
  const connection = await database.openConnection();
  try {
    const [rows] = await connection.execute<RowDataPacket[]>(sql, [...values]);
    return rows;
  } finally {
    await connection.end();
  }
}

async function fixture() {
  const provisioned = await new MySqlPlatformProvisioningRepository(database).provisionMerchant({
    name: `租户边界合成商家 ${randomBytes(4).toString('hex')}`,
    operatorId: 'improvement_isolation_ci',
  });
  const owner = await new MySqlMerchantAccessRepository(
    database,
    randomBytes(32).toString('base64url'),
  ).claimInvitation({
    setupToken: provisioned.setupToken,
    phone: `139${String(randomInt(0, 100_000_000)).padStart(8, '0')}`,
    password: randomBytes(24).toString('base64url'),
  });
  const merchantId = toMerchantId(provisioned.id);
  const merchantUserId = toMerchantUserId(owner.merchantUserId);
  const draft = {
    industry: '电商零售',
    businessScope: '合成保温杯资料，仅用于隔离测试',
    materialsSummary: '合成商品A为500ml保温杯，无真实交易。',
    pricingSummary: '测试报价99元，配送费需核实。',
    promotionSummary: '没有已确认优惠。',
    welcomeMessage: '您好，我是 AI 客服。',
    insufficientInfoMessage: '资料不足，请联系商家确认。',
    humanContact: '请通过测试店铺订单页联系人工。',
  };
  const creationInput = {
    merchantId,
    merchantUserId,
    displayName: '隔离测试客服A',
    draft,
    idempotency: idem(),
    now: new Date(),
  };
  const snapshot = await lifecycle.createManualDraft(creationInput);
  const actor = { merchantId, merchantUserId, assistantId: toAssistantId(snapshot.assistantId) };
  await lifecycle.confirmDraftKnowledge({ ...actor, expectedDraftRevision: 1, now: new Date() });
  const publicationInput = {
    ...actor,
    expectedDraftRevision: 1,
    ...policy,
    retrievalPolicyVersion: 'isolation-v1',
    idempotency: idem(),
    now: new Date(),
  };
  const release = await lifecycle.publish(publicationInput);
  return { actor, draft, snapshot, release, creationInput, publicationInput };
}

async function secondAssistant(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = await lifecycle.createManualDraft({
    merchantId: f.actor.merchantId,
    merchantUserId: f.actor.merchantUserId,
    displayName: '同商家隔离测试客服B',
    draft: f.draft,
    idempotency: idem(),
    now: new Date(),
  });
  return { ...f.actor, assistantId: toAssistantId(snapshot.assistantId) };
}

async function sourceMessage(f: Awaited<ReturnType<typeof fixture>>) {
  const session = await new MySqlPublicSessionRepository(
    database,
    randomBytes(32).toString('base64url'),
  ).createSession({
    publicSlug: f.snapshot.publicSlug,
    sessionRequestId: `session_request_${randomBytes(16).toString('hex')}`,
    visitorNonce: randomBytes(32).toString('base64url'),
    now: new Date(),
  });
  const sourceMessageId = randomBytes(16).toString('hex');
  const sessionId = session.sessionHandle.slice(2);
  // Insert valid immutable message fixtures without enqueueing a global job: this prevents
  // parallel suites' claimNext workers from accidentally claiming this suite's pending work.
  const connection = await database.openConnection();
  try {
    await connection.execute(
      `INSERT INTO message (id, merchant_id, assistant_id, session_id, turn_id, seq_no, role, state, client_request_id, content, created_at, completed_at) VALUES (?, ?, ?, ?, ?, 1, 'visitor', 'completed', ?, ?, ?, ?)`,
      [
        idBytes(sourceMessageId),
        idBytes(f.actor.merchantId),
        idBytes(f.actor.assistantId),
        idBytes(sessionId),
        randomBytes(16),
        `message_${randomBytes(16).toString('hex')}`,
        '新疆地区能包邮吗？',
        new Date(),
        new Date(),
      ],
    );
    await connection.execute(
      `UPDATE conversation_session SET next_sequence = 2 WHERE merchant_id = ? AND assistant_id = ? AND id = ?`,
      [idBytes(f.actor.merchantId), idBytes(f.actor.assistantId), idBytes(sessionId)],
    );
  } finally {
    await connection.end();
  }
  return { sourceMessageId, sessionId };
}

async function verifiedTask(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await improvements.createScenario(
    write({
      ...f.actor,
      reason: 'missing_information',
      question: '新疆地区能包邮吗？',
      expectedAnswer: '新疆地区不承诺包邮，运费须联系商家核实。',
      notes: '合成商家确认的测试规则。',
    }),
  );
  const applied = await improvements.applyCorrection(
    write({
      ...f.actor,
      improvementId: task.id,
      expectedVersion: task.version,
      expectedDraftRevision: 1,
    }),
  );
  const started = await improvements.startEvaluation(
    write({
      ...f.actor,
      improvementId: task.id,
      expectedVersion: applied.improvement.version,
      expectedDraftRevision: applied.draftRevision,
      ...policy,
    }),
  );
  await improvements.finishEvaluation(
    write({
      ...f.actor,
      improvementId: task.id,
      runId: started.run.id,
      answer: '合成回答夹具：新疆需另核运费，不承诺包邮。',
      errorCode: null,
    }),
  );
  await improvements.reviewEvaluation(
    write({
      ...f.actor,
      improvementId: task.id,
      runId: started.run.id,
      expectedVersion: applied.improvement.version,
      expectedDraftRevision: applied.draftRevision,
      verdict: 'pass',
    }),
  );
  await lifecycle.confirmDraftKnowledge({
    ...f.actor,
    expectedDraftRevision: applied.draftRevision,
    now: new Date(),
  });
  return { task: applied.improvement, runId: started.run.id, revision: applied.draftRevision };
}

describe('real MySQL improvement isolation and rollback invariants', () => {
  it('returns original creation/publication results while authorized, but rejects original-key replays after revocation or merchant pause', async () => {
    for (const revoke of ['membership', 'merchant'] as const) {
      const f = await fixture();
      expect(
        (await lifecycle.createManualDraft({ ...f.creationInput, now: new Date() })).assistantId,
      ).toBe(f.snapshot.assistantId);
      expect((await lifecycle.publish({ ...f.publicationInput, now: new Date() })).releaseId).toBe(
        f.release.releaseId,
      );
      const connection = await database.openConnection();
      try {
        if (revoke === 'membership') {
          await connection.execute(
            "UPDATE merchant_membership SET status = 'revoked' WHERE merchant_id = ? AND merchant_user_id = ?",
            [idBytes(f.actor.merchantId), idBytes(f.actor.merchantUserId)],
          );
        } else {
          await connection.execute("UPDATE merchant SET status = 'paused' WHERE id = ?", [
            idBytes(f.actor.merchantId),
          ]);
        }
      } finally {
        await connection.end();
      }
      await expect(lifecycle.publish({ ...f.publicationInput, now: new Date() })).rejects.toThrow();
      await expect(
        lifecycle.createManualDraft({ ...f.creationInput, now: new Date() }),
      ).rejects.toThrow();
      const releases = await queryRows(
        'SELECT id, status FROM assistant_release WHERE merchant_id = ? AND assistant_id = ?',
        [idBytes(f.actor.merchantId), idBytes(f.actor.assistantId)],
      );
      expect(releases).toHaveLength(1);
      expect(releases[0]?.['status']).toBe('active');
      expect((releases[0]?.['id'] as Buffer).toString('hex')).toBe(f.release.releaseId);
    }
  });

  it('rechecks created-assistant recovery if membership is revoked after the duplicate attempt rolls back', async () => {
    const f = await fixture();
    let revokedBetweenDuplicateAndRecovery = false;
    const revokeAfterRollback: DatabaseConnectionConfig = {
      ...database,
      openConnection: async () => {
        const connection = await database.openConnection();
        const rollback = connection.rollback.bind(connection);
        connection.rollback = async () => {
          await rollback();
          if (!revokedBetweenDuplicateAndRecovery) {
            revokedBetweenDuplicateAndRecovery = true;
            const revocation = await database.openConnection();
            try {
              await revocation.execute(
                "UPDATE merchant_membership SET status = 'revoked' WHERE merchant_id = ? AND merchant_user_id = ?",
                [idBytes(f.actor.merchantId), idBytes(f.actor.merchantUserId)],
              );
            } finally {
              await revocation.end();
            }
          }
        };
        return connection;
      },
    };
    await expect(
      new MySqlAssistantLifecycleRepository(revokeAfterRollback).createManualDraft({
        ...f.creationInput,
        now: new Date(),
      }),
    ).rejects.toThrow();
    expect(revokedBetweenDuplicateAndRecovery).toBe(true);
    const rows = await queryRows('SELECT id FROM assistant WHERE merchant_id = ?', [
      idBytes(f.actor.merchantId),
    ]);
    expect(rows).toHaveLength(1);
    expect((rows[0]?.['id'] as Buffer).toString('hex')).toBe(f.snapshot.assistantId);
  });

  it('rejects another assistant in the same merchant for source linking and task writes', async () => {
    const f = await fixture();
    const otherActor = await secondAssistant(f);
    const source = await sourceMessage(f);
    const fields = {
      reason: 'missing_information' as const,
      question: '新疆地区能包邮吗？',
      expectedAnswer: '需要核实新疆运费。',
      notes: '',
    };
    const task = await improvements.createFromMessage(
      write({ ...f.actor, ...fields, sourceMessageId: source.sourceMessageId }),
    );
    await expect(
      improvements.createFromMessage(
        write({ ...otherActor, ...fields, sourceMessageId: source.sourceMessageId }),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await improvements.detail({ ...otherActor, improvementId: task.id })).toBeNull();
    await expect(
      improvements.update(
        write({ ...otherActor, ...fields, improvementId: task.id, expectedVersion: task.version }),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      improvements.startEvaluation(
        write({
          ...otherActor,
          improvementId: task.id,
          expectedVersion: task.version,
          expectedDraftRevision: 1,
          ...policy,
        }),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const rows = await queryRows(
      'SELECT id FROM assistant_improvement WHERE merchant_id = ? AND assistant_id = ?',
      [idBytes(f.actor.merchantId), idBytes(otherActor.assistantId)],
    );
    expect(rows).toHaveLength(0);
  });

  it('revokes update, evaluation start and publish when active membership is removed', async () => {
    const f = await fixture();
    const ready = await verifiedTask(f);
    expect(
      (await improvements.detail({ ...f.actor, improvementId: ready.task.id }))?.improvement.state,
    ).toBe('ready_to_publish');
    expect(
      (await lifecycle.findManagementSnapshot(f.actor.merchantId, f.actor.assistantId))
        ?.knowledgeConfirmed,
    ).toBe(true);
    const connection = await database.openConnection();
    try {
      await connection.execute(
        "UPDATE merchant_membership SET status = 'revoked' WHERE merchant_id = ? AND merchant_user_id = ?",
        [idBytes(f.actor.merchantId), idBytes(f.actor.merchantUserId)],
      );
    } finally {
      await connection.end();
    }
    await expect(
      improvements.update(
        write({
          ...f.actor,
          improvementId: ready.task.id,
          expectedVersion: ready.task.version,
          reason: ready.task.reason,
          question: ready.task.question,
          expectedAnswer: '撤权后不得覆盖答案',
          notes: '',
        }),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      improvements.startEvaluation(
        write({
          ...f.actor,
          improvementId: ready.task.id,
          expectedVersion: ready.task.version,
          expectedDraftRevision: ready.revision,
          ...policy,
        }),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const publishIdem = idem();
    await expect(
      lifecycle.publish({
        ...f.actor,
        expectedDraftRevision: ready.revision,
        ...policy,
        retrievalPolicyVersion: 'isolation-v1',
        idempotency: publishIdem,
        now: new Date(),
      }),
    ).rejects.toThrow();
    const tasks = await queryRows(
      'SELECT version, published_release_id FROM assistant_improvement WHERE merchant_id = ? AND assistant_id = ? AND id = ?',
      [idBytes(f.actor.merchantId), idBytes(f.actor.assistantId), idBytes(ready.task.id)],
    );
    expect(tasks[0]?.['version']).toBe(ready.task.version);
    expect(tasks[0]?.['published_release_id']).toBeNull();
    const runs = await queryRows(
      'SELECT id FROM assistant_evaluation_run WHERE merchant_id = ? AND assistant_id = ? AND improvement_id = ?',
      [idBytes(f.actor.merchantId), idBytes(f.actor.assistantId), idBytes(ready.task.id)],
    );
    expect(runs).toHaveLength(1);
    const idempotencyRows = await queryRows(
      "SELECT id FROM idempotency_record WHERE actor_scope_digest = ? AND operation = 'assistant.publish' AND key_digest = ?",
      [publishIdem.actorScopeDigest, publishIdem.keyDigest],
    );
    expect(idempotencyRows).toHaveLength(0);
    expect((await lifecycle.findPublicSnapshot(f.snapshot.publicSlug))?.releaseRef).toBe(
      f.release.releaseId,
    );
  });

  it('lets genuine composite foreign keys reject cross-assistant source messages and evaluation tasks', async () => {
    const f = await fixture();
    const otherActor = await secondAssistant(f);
    const source = await sourceMessage(f);
    const task = await improvements.createScenario(
      write({
        ...f.actor,
        reason: 'other',
        question: '问A客服的问题',
        expectedAnswer: '',
        notes: '',
      }),
    );
    const connection = await database.openConnection();
    try {
      await expect(
        connection.execute(
          `INSERT INTO assistant_improvement (id, merchant_id, assistant_id, version, source_message_id, reason, question, expected_answer, notes, created_by, updated_by) VALUES (?, ?, ?, 1, ?, 'other', '不允许跨客服引用', '', '', ?, ?)`,
          [
            randomBytes(16),
            idBytes(f.actor.merchantId),
            idBytes(otherActor.assistantId),
            idBytes(source.sourceMessageId),
            idBytes(f.actor.merchantUserId),
            idBytes(f.actor.merchantUserId),
          ],
        ),
      ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
      await expect(
        connection.execute(
          `INSERT INTO assistant_evaluation_run (id, merchant_id, assistant_id, improvement_id, task_version, draft_revision, facts_hash, question, expected_answer, state, prompt_template_version, model_policy_version, created_by) VALUES (?, ?, ?, ?, 1, 1, ?, '不允许跨客服引用任务', '', 'pending', 'isolation-v1', 'isolation-v1', ?)`,
          [
            randomBytes(16),
            idBytes(f.actor.merchantId),
            idBytes(otherActor.assistantId),
            idBytes(task.id),
            randomBytes(32),
            idBytes(f.actor.merchantUserId),
          ],
        ),
      ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
    } finally {
      await connection.end();
    }
    const unchanged = await improvements.detail({ ...f.actor, improvementId: task.id });
    expect(unchanged?.runs).toHaveLength(0);
  });

  it('rolls back release, active pointer and improvement binding together after an injected post-binding failure', async () => {
    const f = await fixture();
    const ready = await verifiedTask(f);
    expect(
      (await improvements.detail({ ...f.actor, improvementId: ready.task.id }))?.improvement.state,
    ).toBe('ready_to_publish');
    let actualBindingExecuted = false;
    let actualBindingAffectedRows = 0;
    const faultDatabase: DatabaseConnectionConfig = {
      ...database,
      openConnection: async () => {
        const connection = await database.openConnection();
        const execute = connection.execute.bind(connection);
        connection.execute = (async (sql: string, values?: ExecuteValues) => {
          const result = await execute(sql, values);
          if (sql.trimStart().startsWith('UPDATE assistant_improvement')) {
            actualBindingExecuted = true;
            actualBindingAffectedRows = Number(
              (result[0] as { affectedRows?: unknown }).affectedRows,
            );
            throw new Error('synthetic_failure_after_actual_improvement_binding');
          }
          return result;
        }) as Connection['execute'];
        return connection;
      },
    };
    const publishIdem = idem();
    await expect(
      new MySqlAssistantLifecycleRepository(faultDatabase).publish({
        ...f.actor,
        expectedDraftRevision: ready.revision,
        ...policy,
        retrievalPolicyVersion: 'isolation-v1',
        idempotency: publishIdem,
        now: new Date(),
      }),
    ).rejects.toThrow('synthetic_failure_after_actual_improvement_binding');
    expect(actualBindingExecuted).toBe(true);
    expect(actualBindingAffectedRows).toBe(1);
    const detail = await improvements.detail({ ...f.actor, improvementId: ready.task.id });
    expect(detail?.improvement.state).toBe('ready_to_publish');
    expect(detail?.improvement.publishedReleaseId).toBeNull();
    expect(detail?.improvement.publishedTaskVersion).toBeNull();
    expect((await lifecycle.findPublicSnapshot(f.snapshot.publicSlug))?.releaseRef).toBe(
      f.release.releaseId,
    );
    const releases = await queryRows(
      'SELECT id, status FROM assistant_release WHERE merchant_id = ? AND assistant_id = ?',
      [idBytes(f.actor.merchantId), idBytes(f.actor.assistantId)],
    );
    expect(releases).toHaveLength(1);
    expect(releases[0]?.['status']).toBe('active');
    const idempotencyRows = await queryRows(
      "SELECT id FROM idempotency_record WHERE actor_scope_digest = ? AND operation = 'assistant.publish' AND key_digest = ?",
      [publishIdem.actorScopeDigest, publishIdem.keyDigest],
    );
    expect(idempotencyRows).toHaveLength(0);
    const audits = await queryRows(
      "SELECT target_type, target_id, metadata FROM audit_log WHERE merchant_id = ? AND action = 'improvement.evaluate.review'",
      [idBytes(f.actor.merchantId)],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.['target_type']).toBe('assistant_improvement');
    expect(audits[0]?.['target_id']).toBe(ready.task.id);
    const metadata: unknown =
      typeof audits[0]?.['metadata'] === 'string'
        ? JSON.parse(audits[0]['metadata'] as string)
        : audits[0]?.['metadata'];
    expect(metadata).toEqual({
      assistantId: f.actor.assistantId,
      improvementId: ready.task.id,
      runId: ready.runId,
    });
  });
});
