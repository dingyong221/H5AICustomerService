import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'mysql2/promise';
import { ImprovementConflictError, type AssistantDraftConfig } from '@h5cs/domain';
import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  MySqlAssistantImprovementRepository,
  assistantFactsHash,
} from '../src/assistant-improvement-repository.js';
import { bindVerifiedImprovementsToRelease } from '../src/assistant-improvement-release.js';

const merchantId = '11'.repeat(16);
const merchantUserId = '22'.repeat(16);
const assistantId = '33'.repeat(16);
const sourceMessageId = '44'.repeat(16);
const sourceSessionId = '55'.repeat(16);
const sourceReleaseId = '66'.repeat(16);
const now = new Date('2026-10-17T04:00:00Z');
const actor = { merchantId, merchantUserId, assistantId };
const edit = {
  reason: 'missing_information' as const,
  question: '新疆包邮吗？',
  expectedAnswer: '新疆运费需联系商家核价，不承诺包邮。',
  notes: '以商家已确认规则为准。',
};
const draft: AssistantDraftConfig = {
  industry: '电商零售',
  businessScope: '家居用品销售',
  materialsSummary: '商品A：100元，普通地区运费10元。',
  pricingSummary: '100元',
  promotionSummary: '没有已确认优惠',
  welcomeMessage: '您好，我是AI客服。',
  insufficientInfoMessage: '待确认，请联系商家。',
};
type FakeRow = Record<string, unknown>;
const bytes = (value: string) => Buffer.from(value, 'hex');
const asHex = (value: unknown) => (Buffer.isBuffer(value) ? value.toString('hex') : String(value));

/** This is a strict SQL interaction double, NOT a MySQL integration test. */
const fixture = () => {
  const tasks = new Map<string, FakeRow>();
  const runs = new Map<string, FakeRow>();
  const idempotency = new Map<string, FakeRow>();
  const context = {
    display_name: '零售AI客服',
    status: 'active',
    draft_revision: 1,
    active_release_id: bytes(sourceReleaseId),
    config: { ...draft },
  };
  let authorized = true;
  let sourceExists = true;
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const execute = vi.fn(
    async (sql: string, values: readonly unknown[] = []): Promise<unknown[]> => {
      calls.push({ sql, values });
      const ok = [{ affectedRows: 1 }, []];
      if (sql.startsWith('SELECT a.display_name'))
        return [
          [
            ...(authorized &&
            asHex(values[0]) === merchantUserId &&
            asHex(values[1]) === merchantId &&
            asHex(values[2]) === assistantId
              ? [context]
              : []),
          ],
          [],
        ];
      if (sql.startsWith('SELECT request_hash'))
        return [
          [
            ...(idempotency.has(`${asHex(values[0])}:${values[1]}:${asHex(values[2])}`)
              ? [idempotency.get(`${asHex(values[0])}:${values[1]}:${asHex(values[2])}`)]
              : []),
          ],
          [],
        ];
      if (sql.startsWith('INSERT INTO idempotency_record')) {
        idempotency.set(`${asHex(values[2])}:${values[3]}:${asHex(values[4])}`, {
          id: values[0],
          request_hash: values[5],
          state: 'processing',
          response_body: null,
        });
        return ok;
      }
      if (sql.startsWith('UPDATE idempotency_record')) {
        const row = [...idempotency.values()].find(
          (entry) => asHex(entry['id']) === asHex(values[2]),
        );
        if (!row) throw new Error('No idempotency row');
        row['state'] = 'succeeded';
        row['response_body'] = values[0];
        return ok;
      }
      if (sql.startsWith('INSERT INTO audit_log')) return ok;
      if (sql.startsWith('SELECT i.*'))
        return [
          [
            ...(authorized
              ? [...tasks.values()].map((row) => ({
                  ...row,
                  ...context,
                  assistant_status: context.status,
                }))
              : []),
          ],
          [],
        ];
      if (sql.startsWith('SELECT r.*')) {
        const latest = new Map<string, FakeRow>();
        for (const row of [...runs.values()].sort(
          (left, right) =>
            (right['created_at'] as Date).getTime() - (left['created_at'] as Date).getTime(),
        ))
          if (!latest.has(asHex(row['improvement_id'])))
            latest.set(asHex(row['improvement_id']), row);
        return [[...(authorized ? latest.values() : [])], []];
      }
      if (sql.startsWith('SELECT v.content'))
        return [
          [
            ...(sourceExists &&
            asHex(values[0]) === merchantId &&
            asHex(values[1]) === assistantId &&
            asHex(values[2]) === sourceMessageId
              ? [
                  {
                    content: edit.question,
                    session_id: bytes(sourceSessionId),
                    release_id: bytes(sourceReleaseId),
                    original_answer: '目前未提供新疆运费，请联系商家确认。',
                  },
                ]
              : []),
          ],
          [],
        ];
      if (sql.startsWith('SELECT * FROM assistant_improvement')) {
        const rows = [...tasks.values()].filter(
          (row) =>
            asHex(row['merchant_id']) === asHex(values[0]) &&
            asHex(row['assistant_id']) === asHex(values[1]) &&
            asHex(row[sql.includes('source_message_id = ?') ? 'source_message_id' : 'id']) ===
              asHex(values[2]),
        );
        return [rows, []];
      }
      if (sql.startsWith('INSERT INTO assistant_improvement')) {
        tasks.set(asHex(values[0]), {
          id: values[0],
          merchant_id: values[1],
          assistant_id: values[2],
          version: 1,
          source_session_id: values[3],
          source_message_id: values[4],
          source_release_id: values[5],
          reason: values[6],
          question: values[7],
          expected_answer: values[8],
          notes: values[9],
          original_answer: values[10],
          applied_block: null,
          applied_draft_revision: null,
          published_release_id: null,
          published_task_version: null,
          created_at: values[13],
          updated_at: values[14],
        });
        return ok;
      }
      if (sql.startsWith('UPDATE assistant_improvement SET version = version + 1, reason')) {
        const task = tasks.get(asHex(values[8]));
        if (!task || task['version'] !== values[9]) return [{ affectedRows: 0 }, []];
        Object.assign(task, {
          version: Number(task['version']) + 1,
          reason: values[0],
          question: values[1],
          expected_answer: values[2],
          notes: values[3],
          applied_draft_revision: null,
          updated_at: values[5],
        });
        return ok;
      }
      if (sql.startsWith('UPDATE assistant_improvement SET version = version + 1, applied_block')) {
        const task = tasks.get(asHex(values[6]));
        if (!task || task['version'] !== values[7]) return [{ affectedRows: 0 }, []];
        Object.assign(task, {
          version: Number(task['version']) + 1,
          applied_block: values[0],
          applied_draft_revision: values[1],
          updated_at: values[3],
        });
        return ok;
      }
      if (sql.startsWith('UPDATE assistant_draft')) {
        if (context.draft_revision !== values[7]) return [{ affectedRows: 0 }, []];
        context.config = JSON.parse(String(values[1])) as AssistantDraftConfig;
        return ok;
      }
      if (sql.startsWith('UPDATE assistant SET draft_revision')) {
        context.draft_revision = Number(values[0]);
        return ok;
      }
      if (sql.startsWith('SELECT * FROM assistant_evaluation_run')) {
        const matching = [...runs.values()].filter(
          (row) =>
            asHex(row['merchant_id']) === asHex(values[0]) &&
            asHex(row['assistant_id']) === asHex(values[1]) &&
            asHex(row['improvement_id']) === asHex(values[2]) &&
            (values.length === 3 || asHex(row['id']) === asHex(values[3])),
        );
        matching.sort(
          (left, right) =>
            (right['created_at'] as Date).getTime() - (left['created_at'] as Date).getTime() ||
            asHex(right['id']).localeCompare(asHex(left['id'])),
        );
        return [matching, []];
      }
      if (sql.startsWith('INSERT INTO assistant_evaluation_run')) {
        runs.set(asHex(values[0]), {
          id: values[0],
          merchant_id: values[1],
          assistant_id: values[2],
          improvement_id: values[3],
          task_version: values[4],
          draft_revision: values[5],
          facts_hash: values[6],
          question: values[7],
          expected_answer: values[8],
          state: 'pending',
          prompt_template_version: values[9],
          model_policy_version: values[10],
          created_at: values[12],
          answer: null,
          error_code: null,
          verdict: null,
          completed_at: null,
          reviewed_at: null,
        });
        return ok;
      }
      if (sql.startsWith("UPDATE assistant_evaluation_run SET state = 'failed'")) {
        const row = runs.get(asHex(values[4]));
        if (!row) throw new Error('No pending row');
        Object.assign(row, {
          state: 'failed',
          error_code: 'evaluation_interrupted',
          completed_at: values[0],
        });
        return ok;
      }
      if (sql.startsWith('UPDATE assistant_evaluation_run SET state = ?')) {
        const row = runs.get(asHex(values[7]));
        if (!row) throw new Error('No pending row');
        Object.assign(row, {
          state: values[0],
          answer: values[1],
          error_code: values[2],
          completed_at: values[3],
        });
        return ok;
      }
      if (sql.startsWith('UPDATE assistant_evaluation_run SET verdict')) {
        const row = runs.get(asHex(values[6]));
        if (!row) throw new Error('No reviewed row');
        Object.assign(row, { verdict: values[0], reviewed_at: values[2] });
        return ok;
      }
      throw new Error(`Unhandled SQL interaction: ${sql}`);
    },
  );
  const beginTransaction = vi.fn(async () => undefined),
    commit = vi.fn(async () => undefined),
    rollback = vi.fn(async () => undefined),
    end = vi.fn(async () => undefined);
  const connection = { execute, beginTransaction, commit, rollback, end } as unknown as Connection;
  const database = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  } satisfies DatabaseConnectionConfig;
  let sequence = 0;
  const write = () => ({
    ...actor,
    now: new Date(now.getTime() + sequence++ * 1_000),
    requestKey: `request_${sequence}`,
  });
  const repository = new MySqlAssistantImprovementRepository(database, {
    promptTemplateVersion: 'v1',
    modelPolicyVersion: 'v1',
  });
  const create = () => repository.createScenario({ ...write(), ...edit });
  const prepare = async () => {
    const task = await create();
    return repository.applyCorrection({
      ...write(),
      improvementId: task.id,
      expectedVersion: task.version,
      expectedDraftRevision: 1,
    });
  };
  const start = (taskId: string, taskVersion: number, revision: number) =>
    repository.startEvaluation({
      ...write(),
      improvementId: taskId,
      expectedVersion: taskVersion,
      expectedDraftRevision: revision,
      promptTemplateVersion: 'v1',
      modelPolicyVersion: 'v1',
    });
  return {
    repository,
    context,
    tasks,
    runs,
    idempotency,
    calls,
    execute,
    rollback,
    commit,
    connection,
    write,
    create,
    prepare,
    start,
    unauthorize: () => {
      authorized = false;
    },
    removeSource: () => {
      sourceExists = false;
    },
  };
};

describe('assistant improvement repository - strict SQL interaction unit tests', () => {
  it('creates a scenario only after locking the assistant and active membership in the transaction', async () => {
    const f = fixture();
    const task = await f.create();
    expect(task.state).toBe('needs_correction');
    expect(task.question).toBe(edit.question);
    expect(f.calls[0]?.sql).toContain('FOR UPDATE');
    expect(f.calls[0]?.sql).toContain("mm.status = 'active'");
    expect(f.calls[0]?.sql).toContain("u.status = 'active'");
    expect(f.calls.at(-1)?.sql).toContain('INSERT INTO audit_log');
    expect(f.calls.at(-1)?.sql).toContain("'assistant_improvement'");
    expect(f.calls.at(-1)?.values[4]).toBe(task.id);
    expect(JSON.parse(String(f.calls.at(-1)?.values[6]))).toEqual({
      assistantId,
      improvementId: task.id,
    });
    expect(String(f.calls.at(-1)?.values[6])).not.toContain(edit.question);
    expect(String(f.calls.at(-1)?.values[6])).not.toContain(edit.expectedAnswer);
    expect(String(f.calls.at(-1)?.values[6])).not.toContain(edit.notes);
    expect(f.commit).toHaveBeenCalledOnce();
  });
  it('takes question, answer and release from the real tenant-qualified visitor source', async () => {
    const f = fixture();
    const task = await f.repository.createFromMessage({
      ...f.write(),
      ...edit,
      question: '伪造的问题不能取代原话',
      sourceMessageId,
    });
    expect(task).toMatchObject({
      question: edit.question,
      sourceMessageId,
      sourceSessionId,
      sourceReleaseId,
      originalAnswer: '目前未提供新疆运费，请联系商家确认。',
    });
    expect(f.calls.find((call) => call.sql.startsWith('SELECT v.content'))?.sql).toContain(
      "v.role = 'visitor'",
    );
    const duplicate = await f.repository.createFromMessage({
      ...f.write(),
      ...edit,
      sourceMessageId,
    });
    expect(duplicate.id).toBe(task.id);
    expect(f.tasks.size).toBe(1);
  });
  it('rejects missing/cross-tenant/cross-assistant message references and rolls back', async () => {
    const f = fixture();
    f.removeSource();
    await expect(
      f.repository.createFromMessage({ ...f.write(), ...edit, sourceMessageId }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.tasks.size).toBe(0);
    expect(f.rollback).toHaveBeenCalledOnce();
    const other = fixture();
    await expect(
      other.repository.createScenario({ ...other.write(), ...edit, assistantId: '99'.repeat(16) }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(other.calls).toHaveLength(1);
  });
  it('recovers the same write and dates via idempotency, but rejects a changed request hash', async () => {
    const f = fixture();
    const input = { ...f.write(), ...edit };
    const first = await f.repository.createScenario(input);
    const repeat = await f.repository.createScenario({
      ...input,
      now: new Date(now.getTime() + 5_000),
    });
    expect(repeat.id).toBe(first.id);
    expect(repeat.createdAt).toBeInstanceOf(Date);
    expect(f.tasks.size).toBe(1);
    await expect(
      f.repository.createScenario({ ...input, expectedAnswer: '另一答案' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('rechecks authorization even for an existing idempotency response', async () => {
    const f = fixture();
    const input = { ...f.write(), ...edit };
    await f.repository.createScenario(input);
    f.unauthorize();
    await expect(f.repository.createScenario(input)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('returns only fifty visible rows while counting all merchant issues, not just the visible slice', async () => {
    const f = fixture();
    for (let index = 0; index < 53; index++) await f.create();
    const result = await f.repository.list({ merchantId, merchantUserId });
    expect(result.items).toHaveLength(50);
    expect(result.total).toBe(53);
    expect(result.truncated).toBe(true);
    expect(result.counts.needs_correction).toBe(53);
    expect(f.calls.find((call) => call.sql.startsWith('SELECT i.*'))?.sql).toContain(
      'mm.merchant_user_id = ?',
    );
  });
  it('applies a revision-checked FAQ while preserving every original fact and invalidating knowledge confirmation', async () => {
    const f = fixture();
    const result = await f.prepare();
    expect(result.draftRevision).toBe(2);
    expect(result.improvement.version).toBe(2);
    expect(result.improvement.state).toBe('needs_evaluation');
    expect(f.context.config.materialsSummary).toContain(draft.materialsSummary);
    expect(f.context.config.materialsSummary).toContain(edit.expectedAnswer);
    const save = f.calls.find((call) => call.sql.startsWith('UPDATE assistant_draft'))!;
    expect(JSON.parse(String(save.values[2]))).toMatchObject({
      publishable: false,
      reason: 'knowledge_not_verified',
    });
    expect(f.calls.some((call) => call.sql.includes('UPDATE assistant_release'))).toBe(false);
  });
  it('rejects stale task/draft writes rather than overwriting another tab', async () => {
    const f = fixture();
    const task = await f.create();
    await expect(
      f.repository.applyCorrection({
        ...f.write(),
        improvementId: task.id,
        expectedVersion: 99,
        expectedDraftRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    await expect(
      f.repository.applyCorrection({
        ...f.write(),
        improvementId: task.id,
        expectedVersion: task.version,
        expectedDraftRevision: 99,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    expect(f.context.config.materialsSummary).toBe(draft.materialsSummary);
  });
  it('does not change a source-linked original question through a forged edit form', async () => {
    const f = fixture();
    const task = await f.repository.createFromMessage({ ...f.write(), ...edit, sourceMessageId });
    await expect(
      f.repository.update({
        ...f.write(),
        ...edit,
        question: '替换原话',
        improvementId: task.id,
        expectedVersion: task.version,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
  it('replaces the managed block after a second confirmed correction rather than retaining conflicting FAQs', async () => {
    const f = fixture();
    const first = await f.prepare();
    const updated = await f.repository.update({
      ...f.write(),
      ...edit,
      expectedAnswer: '新规则：新疆不包邮。',
      improvementId: first.improvement.id,
      expectedVersion: first.improvement.version,
    });
    expect(updated.state).toBe('needs_correction');
    await f.repository.applyCorrection({
      ...f.write(),
      improvementId: updated.id,
      expectedVersion: updated.version,
      expectedDraftRevision: 2,
    });
    expect(f.context.config.materialsSummary).toContain('新规则：新疆不包邮。');
    expect(f.context.config.materialsSummary).not.toContain(edit.expectedAnswer);
    expect(f.context.config.materialsSummary.match(/\[FAQ-/gu)).toHaveLength(1);
  });
  it('refuses to overwrite merchant edits inside a managed block', async () => {
    const f = fixture();
    const result = await f.prepare();
    f.context.config.materialsSummary = f.context.config.materialsSummary.replace(
      edit.expectedAnswer,
      '商家手工改过',
    );
    await expect(
      f.repository.applyCorrection({
        ...f.write(),
        improvementId: result.improvement.id,
        expectedVersion: result.improvement.version,
        expectedDraftRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'managed_block_changed' });
  });
  it('deduplicates pending evaluations even when a second tab uses a different request key', async () => {
    const f = fixture();
    const result = await f.prepare();
    const first = await f.start(result.improvement.id, result.improvement.version, 2);
    const second = await f.start(result.improvement.id, result.improvement.version, 2);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(f.runs.size).toBe(1);
  });
  it('does not restart the model when startEvaluation itself is replayed', async () => {
    const f = fixture();
    const result = await f.prepare();
    const input = {
      ...f.write(),
      improvementId: result.improvement.id,
      expectedVersion: result.improvement.version,
      expectedDraftRevision: 2,
      promptTemplateVersion: 'v1',
      modelPolicyVersion: 'v1',
    };
    const first = await f.repository.startEvaluation(input);
    const repeat = await f.repository.startEvaluation(input);
    expect(repeat.run.id).toBe(first.run.id);
    expect(repeat.started).toBe(false);
  });
  it('assigns monotonically increasing run timestamps even when callers use the same millisecond', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    const started = await f.start(prepared.improvement.id, prepared.improvement.version, 2);
    await f.repository.finishEvaluation({
      ...f.write(),
      improvementId: prepared.improvement.id,
      runId: started.run.id,
      answer: edit.expectedAnswer,
      errorCode: null,
    });
    const next = await f.repository.startEvaluation({
      ...f.write(),
      now: started.run.createdAt,
      improvementId: prepared.improvement.id,
      expectedVersion: prepared.improvement.version,
      expectedDraftRevision: 2,
      promptTemplateVersion: 'v1',
      modelPolicyVersion: 'v1',
    });
    expect(next.run.createdAt.getTime()).toBe(started.run.createdAt.getTime() + 1);
    expect(
      (await f.repository.detail({ ...actor, improvementId: prepared.improvement.id }))?.runs[0]
        ?.id,
    ).toBe(next.run.id);
  });
  it('preserves interrupted run history and permits recovery only after its bounded pending lease', async () => {
    const f = fixture();
    const result = await f.prepare();
    const first = await f.start(result.improvement.id, result.improvement.version, 2);
    const recovered = await f.repository.startEvaluation({
      ...f.write(),
      now: new Date(now.getTime() + 180_000),
      improvementId: result.improvement.id,
      expectedVersion: result.improvement.version,
      expectedDraftRevision: 2,
      promptTemplateVersion: 'v1',
      modelPolicyVersion: 'v1',
    });
    expect(recovered.started).toBe(true);
    expect(recovered.run.id).not.toBe(first.run.id);
    expect(f.runs.get(first.run.id)?.['error_code']).toBe('evaluation_interrupted');
    await expect(
      f.repository.finishEvaluation({
        ...f.write(),
        improvementId: result.improvement.id,
        runId: first.run.id,
        answer: '迟来的答案',
        errorCode: null,
      }),
    ).rejects.toMatchObject({ code: 'stale' });
  });
  it('requires a stored real answer and explicit latest-run merchant pass before becoming ready', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    const started = await f.start(prepared.improvement.id, prepared.improvement.version, 2);
    await expect(
      f.repository.reviewEvaluation({
        ...f.write(),
        improvementId: prepared.improvement.id,
        runId: started.run.id,
        expectedVersion: prepared.improvement.version,
        expectedDraftRevision: 2,
        verdict: 'pass',
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    await f.repository.finishEvaluation({
      ...f.write(),
      improvementId: prepared.improvement.id,
      runId: started.run.id,
      answer: edit.expectedAnswer,
      errorCode: null,
    });
    expect(
      (await f.repository.detail({ ...actor, improvementId: prepared.improvement.id }))?.improvement
        .state,
    ).toBe('needs_review');
    await f.repository.reviewEvaluation({
      ...f.write(),
      improvementId: prepared.improvement.id,
      runId: started.run.id,
      expectedVersion: prepared.improvement.version,
      expectedDraftRevision: 2,
      verdict: 'pass',
    });
    expect(
      (await f.repository.detail({ ...actor, improvementId: prepared.improvement.id }))?.improvement
        .state,
    ).toBe('ready_to_publish');
  });

  it('links evaluation start, finish and review audits to exact task and run IDs without business text', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    const started = await f.start(prepared.improvement.id, prepared.improvement.version, 2);
    await f.repository.finishEvaluation({
      ...f.write(),
      improvementId: prepared.improvement.id,
      runId: started.run.id,
      answer: edit.expectedAnswer,
      errorCode: null,
    });
    await f.repository.reviewEvaluation({
      ...f.write(),
      improvementId: prepared.improvement.id,
      runId: started.run.id,
      expectedVersion: prepared.improvement.version,
      expectedDraftRevision: 2,
      verdict: 'pass',
    });
    const auditCalls = f.calls.filter(
      (call) =>
        call.sql.startsWith('INSERT INTO audit_log') &&
        String(call.values[3]).startsWith('improvement.evaluate.'),
    );
    expect(auditCalls).toHaveLength(3);
    for (const call of auditCalls) {
      expect(call.values[4]).toBe(prepared.improvement.id);
      expect(JSON.parse(String(call.values[6]))).toEqual({
        assistantId,
        improvementId: prepared.improvement.id,
        runId: started.run.id,
      });
      expect(String(call.values[6])).not.toContain(edit.question);
      expect(String(call.values[6])).not.toContain(edit.expectedAnswer);
      expect(String(call.values[6])).not.toContain(edit.notes);
    }
  });
  it('retains late answers as history but rejects review after task, draft or facts changed', async () => {
    for (const drift of ['task', 'revision', 'facts']) {
      const f = fixture();
      const prepared = await f.prepare();
      const started = await f.start(prepared.improvement.id, prepared.improvement.version, 2);
      if (drift === 'task') f.tasks.get(prepared.improvement.id)!['version'] = 9;
      if (drift === 'revision') f.context.draft_revision = 9;
      if (drift === 'facts') f.context.config.pricingSummary = '未通过保存的新价格';
      await f.repository.finishEvaluation({
        ...f.write(),
        improvementId: prepared.improvement.id,
        runId: started.run.id,
        answer: edit.expectedAnswer,
        errorCode: null,
      });
      await expect(
        f.repository.reviewEvaluation({
          ...f.write(),
          improvementId: prepared.improvement.id,
          runId: started.run.id,
          expectedVersion: prepared.improvement.version,
          expectedDraftRevision: 2,
          verdict: 'pass',
        }),
      ).rejects.toMatchObject({ code: 'stale' });
      expect(f.runs.get(started.run.id)?.['answer']).toBe(edit.expectedAnswer);
    }
  });
  it('does not allow a reviewed verdict to be silently rewritten', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    const started = await f.start(prepared.improvement.id, prepared.improvement.version, 2);
    await f.repository.finishEvaluation({
      ...f.write(),
      improvementId: prepared.improvement.id,
      runId: started.run.id,
      answer: edit.expectedAnswer,
      errorCode: null,
    });
    const input = {
      ...f.write(),
      improvementId: prepared.improvement.id,
      runId: started.run.id,
      expectedVersion: prepared.improvement.version,
      expectedDraftRevision: 2,
      verdict: 'fail' as const,
    };
    await f.repository.reviewEvaluation(input);
    await expect(
      f.repository.reviewEvaluation({ ...input, ...f.write(), verdict: 'pass' }),
    ).rejects.toMatchObject({ code: 'stale' });
  });
  it('does not call a paused assistant model and rejects mismatched configured policy versions', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    f.context.status = 'paused';
    await expect(
      f.start(prepared.improvement.id, prepared.improvement.version, 2),
    ).rejects.toMatchObject({ code: 'stale' });
    f.context.status = 'active';
    await expect(
      f.repository.startEvaluation({
        ...f.write(),
        improvementId: prepared.improvement.id,
        expectedVersion: prepared.improvement.version,
        expectedDraftRevision: 2,
        promptTemplateVersion: 'forged-v2',
        modelPolicyVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'stale' });
    expect(f.runs.size).toBe(0);
  });
  it('does not accept forged run IDs, empty answers, errors plus answers or over-limit material', async () => {
    const f = fixture();
    const prepared = await f.prepare();
    for (const input of [
      { answer: '', errorCode: null },
      { answer: 'a', errorCode: 'failed' },
      { answer: null, errorCode: null },
    ])
      await expect(
        f.repository.finishEvaluation({
          ...f.write(),
          improvementId: prepared.improvement.id,
          runId: '99'.repeat(16),
          ...input,
        }),
      ).rejects.toBeInstanceOf(ImprovementConflictError);
    f.context.config.materialsSummary = 'a'.repeat(3_999);
    await expect(
      f.repository.applyCorrection({
        ...f.write(),
        improvementId: prepared.improvement.id,
        expectedVersion: prepared.improvement.version,
        expectedDraftRevision: 2,
      }),
    ).rejects.toBeInstanceOf(ImprovementConflictError);
  });
  it('scopes publishing to matching task, revision, facts hash and policy, ignoring superseded evaluations', async () => {
    const execute = vi.fn(async () => [{ affectedRows: 1 }, []]);
    await bindVerifiedImprovementsToRelease({ execute } as unknown as Connection, {
      merchantId: bytes(merchantId),
      assistantId: bytes(assistantId),
      releaseId: bytes(sourceReleaseId),
      draftRevision: 2,
      factsHash: bytes('aa'.repeat(32)),
      promptTemplateVersion: 'v1',
      modelPolicyVersion: 'v1',
      now,
    });
    const sql = (execute.mock.calls[0] as unknown as [string, unknown[]])[0];
    for (const clause of [
      'r.task_version = i.version',
      'r.draft_revision = ?',
      'r.facts_hash = ?',
      "r.verdict = 'pass'",
      'r.prompt_template_version = ?',
      'r.model_policy_version = ?',
      'NOT EXISTS',
    ])
      expect(sql).toContain(clause);
  });
  it('adds only two InnoDB tables and composite scope constraints without destructive alterations', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'migrations/0012_chilly_talisman.sql'),
      'utf8',
    );
    expect(sql.match(/CREATE TABLE/gu)).toHaveLength(2);
    expect(sql.match(/ENGINE=InnoDB/gu)).toHaveLength(2);
    expect(sql).toContain('fk_improvement_message');
    expect(sql).toContain('fk_evaluation_improvement');
    expect(sql).not.toMatch(/DROP|TRUNCATE|DELETE FROM/iu);
  });
  it('hashes normalized facts exactly rather than treating revision numbers as content proof', () => {
    expect(assistantFactsHash(draft)).toBe(
      createHash('sha256').update(JSON.stringify(draft), 'utf8').digest('hex'),
    );
    expect(assistantFactsHash({ ...draft, pricingSummary: '200元' })).not.toBe(
      assistantFactsHash(draft),
    );
  });
});
