import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import {
  applyImprovementFaq,
  deriveImprovementState,
  ImprovementConflictError,
  improvementReasons,
  type AssistantDraftConfig,
  type AssistantEvaluationRun,
  type AssistantImprovement,
  type AssistantImprovementRepository,
  type ImprovementActor,
  type ImprovementDetail,
  type ImprovementEdit,
  type ImprovementList,
  type ImprovementReason,
  type ImprovementState,
  type ImprovementWrite,
  type ImprovementEvaluationPolicy,
} from '@h5cs/domain';
import type { DatabaseConnectionConfig } from './config.js';
import { parseAssistantDraft, validateAssistantDraft } from './assistant-lifecycle-repository.js';

type Row = RowDataPacket & Record<string, unknown>;
type Context = Readonly<{
  draft: AssistantDraftConfig;
  revision: number;
  hash: string;
  name: string;
  status: string;
  activeReleaseId: string | null;
  policy?: ImprovementEvaluationPolicy;
}>;
const id = (value: string): Buffer => {
  if (!/^[0-9a-f]{32}$/u.test(value)) throw new ImprovementConflictError('invalid');
  return Buffer.from(value, 'hex');
};
const hex = (value: unknown): string => {
  if (!Buffer.isBuffer(value)) throw new ImprovementConflictError('unavailable');
  return value.toString('hex');
};
const nullableHex = (value: unknown): string | null => (value == null ? null : hex(value));
const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new ImprovementConflictError('unavailable');
  return value;
};
const text = (value: string, maximum: number, allowEmpty = false): string => {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value) ||
    (!allowEmpty && !value.trim())
  )
    throw new ImprovementConflictError('invalid');
  return value.trim();
};
const number = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new ImprovementConflictError('unavailable');
  return parsed;
};
const date = (value: unknown): Date => {
  const parsed = value instanceof Date ? value : new Date(string(value));
  if (!Number.isFinite(parsed.getTime())) throw new ImprovementConflictError('unavailable');
  return parsed;
};
export const assistantFactsHash = (draft: AssistantDraftConfig): string =>
  createHash('sha256').update(JSON.stringify(draft), 'utf8').digest('hex');
const validateEdit = (edit: ImprovementEdit): ImprovementEdit => {
  if (!improvementReasons.includes(edit.reason)) throw new ImprovementConflictError('invalid');
  return {
    reason: edit.reason,
    question: text(edit.question, 2_000),
    expectedAnswer: text(edit.expectedAnswer, 2_000, true),
    notes: text(edit.notes, 2_000, true),
  };
};
const parseRun = (row: Row): AssistantEvaluationRun => {
  if (
    !['pending', 'completed', 'failed'].includes(string(row['state'])) ||
    (row['verdict'] != null && row['verdict'] !== 'pass' && row['verdict'] !== 'fail')
  )
    throw new ImprovementConflictError('unavailable');
  return {
    id: hex(row['id']),
    improvementId: hex(row['improvement_id']),
    taskVersion: number(row['task_version']),
    draftRevision: number(row['draft_revision']),
    factsHash: hex(row['facts_hash']),
    question: string(row['question']),
    expectedAnswer: string(row['expected_answer']),
    answer: row['answer'] == null ? null : string(row['answer']),
    errorCode: row['error_code'] == null ? null : string(row['error_code']),
    state: row['state'] as AssistantEvaluationRun['state'],
    verdict: row['verdict'] as AssistantEvaluationRun['verdict'],
    createdAt: date(row['created_at']),
    completedAt: row['completed_at'] == null ? null : date(row['completed_at']),
    reviewedAt: row['reviewed_at'] == null ? null : date(row['reviewed_at']),
    promptTemplateVersion: string(row['prompt_template_version']),
    modelPolicyVersion: string(row['model_policy_version']),
  };
};
const parseTask = (
  row: Row,
  context: Context,
  latest: AssistantEvaluationRun | null,
): AssistantImprovement => {
  const expectedAnswer = string(row['expected_answer']);
  const appliedBlock = row['applied_block'] == null ? null : string(row['applied_block']);
  const appliedDraftRevision =
    row['applied_draft_revision'] == null ? null : number(row['applied_draft_revision']);
  const publishedTaskVersion =
    row['published_task_version'] == null ? null : number(row['published_task_version']);
  const version = number(row['version']);
  return {
    id: hex(row['id']),
    merchantId: hex(row['merchant_id']),
    assistantId: hex(row['assistant_id']),
    version,
    reason: string(row['reason']) as ImprovementReason,
    question: string(row['question']),
    expectedAnswer,
    notes: string(row['notes']),
    sourceSessionId: nullableHex(row['source_session_id']),
    sourceMessageId: nullableHex(row['source_message_id']),
    sourceReleaseId: nullableHex(row['source_release_id']),
    originalAnswer: row['original_answer'] == null ? null : string(row['original_answer']),
    appliedBlock,
    appliedDraftRevision,
    publishedReleaseId: nullableHex(row['published_release_id']),
    publishedTaskVersion,
    createdAt: date(row['created_at']),
    updatedAt: date(row['updated_at']),
    state: deriveImprovementState({
      taskVersion: version,
      expectedAnswer,
      appliedBlock:
        appliedBlock && context.draft.materialsSummary.includes(appliedBlock) ? appliedBlock : null,
      appliedDraftRevision,
      publishedTaskVersion,
      publishedReleaseId: nullableHex(row['published_release_id']),
      activeReleaseId: context.activeReleaseId,
      currentDraftRevision: context.revision,
      currentFactsHash: context.hash,
      latestRun: latest,
      ...(context.policy ? { currentPolicy: context.policy } : {}),
    }),
  };
};
const restoreDates = (value: unknown, key = ''): unknown => {
  if (value === null || typeof value !== 'object')
    return typeof value === 'string' && /At$/u.test(key) ? new Date(value) : value;
  if (Array.isArray(value)) return value.map((entry) => restoreDates(entry));
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, restoreDates(entry, name)]),
  );
};
const canonical = (value: unknown): unknown =>
  value instanceof Date
    ? value.toISOString()
    : Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
const auditId = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value) ? value : null;

/** Audit only stable entity identifiers, never merchant questions, answers, credentials or notes. */
const auditTarget = (input: ImprovementWrite, response: unknown) => {
  const request = record(input);
  const result = record(response);
  const nestedRun = record(result['run']);
  const nestedTask = record(result['improvement']);
  const improvementId =
    auditId(request['improvementId']) ??
    auditId(result['improvementId']) ??
    auditId(nestedRun['improvementId']) ??
    auditId(nestedTask['id']) ??
    (result['assistantId'] === input.assistantId ? auditId(result['id']) : null);
  if (improvementId === null) throw new ImprovementConflictError('unavailable');
  const runId =
    auditId(request['runId']) ??
    auditId(nestedRun['id']) ??
    (auditId(result['improvementId']) !== null ? auditId(result['id']) : null);
  return { improvementId, runId };
};

/** Every mutation obtains the same assistant -> idempotency -> task -> run lock order. */
export class MySqlAssistantImprovementRepository implements AssistantImprovementRepository {
  public constructor(
    private readonly database: DatabaseConnectionConfig,
    private readonly currentPolicy?: ImprovementEvaluationPolicy,
  ) {}
  #policy(): ImprovementEvaluationPolicy | undefined {
    const promptTemplateVersion = process.env['PUBLISH_PROMPT_TEMPLATE_VERSION'];
    const modelPolicyVersion = process.env['PUBLISH_MODEL_POLICY_VERSION'];
    return (
      this.currentPolicy ??
      (promptTemplateVersion && modelPolicyVersion
        ? { promptTemplateVersion, modelPolicyVersion }
        : undefined)
    );
  }

  async #context(connection: Connection, input: ImprovementActor, lock: boolean): Promise<Context> {
    const [rows] = await connection.execute<Row[]>(
      `SELECT a.display_name, a.status, a.draft_revision, a.active_release_id, d.config
         FROM assistant a JOIN assistant_draft d ON d.merchant_id = a.merchant_id AND d.assistant_id = a.id
         JOIN merchant m ON m.id = a.merchant_id AND m.status = 'active'
         JOIN merchant_membership mm ON mm.merchant_id = a.merchant_id AND mm.merchant_user_id = ? AND mm.status = 'active'
         JOIN merchant_user u ON u.id = mm.merchant_user_id AND u.status = 'active'
        WHERE a.merchant_id = ? AND a.id = ?${lock ? " AND mm.role IN ('owner','admin','editor')" : ''} LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [id(input.merchantUserId), id(input.merchantId), id(input.assistantId)],
    );
    if (!rows[0]) throw new ImprovementConflictError('unavailable');
    const draft = parseAssistantDraft(rows[0]['config'] as string | Record<string, unknown>);
    const policy = this.#policy();
    return {
      draft,
      hash: assistantFactsHash(draft),
      revision: number(rows[0]['draft_revision']),
      name: string(rows[0]['display_name']),
      status: string(rows[0]['status']),
      activeReleaseId: nullableHex(rows[0]['active_release_id']),
      ...(policy ? { policy } : {}),
    };
  }

  async #task(
    connection: Connection,
    input: ImprovementActor,
    improvementId: string,
    lock: boolean,
  ): Promise<Row> {
    const [rows] = await connection.execute<Row[]>(
      `SELECT * FROM assistant_improvement WHERE merchant_id = ? AND assistant_id = ? AND id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [id(input.merchantId), id(input.assistantId), id(improvementId)],
    );
    if (!rows[0]) throw new ImprovementConflictError('unavailable');
    return rows[0];
  }
  async #runs(
    connection: Connection,
    input: ImprovementActor,
    improvementId: string,
  ): Promise<AssistantEvaluationRun[]> {
    const [rows] = await connection.execute<Row[]>(
      `SELECT * FROM assistant_evaluation_run WHERE merchant_id = ? AND assistant_id = ? AND improvement_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
      [id(input.merchantId), id(input.assistantId), id(improvementId)],
    );
    return rows.map(parseRun);
  }
  async #snapshot(
    connection: Connection,
    input: ImprovementActor,
    improvementId: string,
    context: Context,
  ): Promise<AssistantImprovement> {
    return parseTask(
      await this.#task(connection, input, improvementId, false),
      context,
      (await this.#runs(connection, input, improvementId))[0] ?? null,
    );
  }
  async #write<T>(
    operation: string,
    input: ImprovementWrite,
    action: (connection: Connection, context: Context) => Promise<T>,
    replay?: (response: T) => T,
  ): Promise<T> {
    if (
      typeof input.requestKey !== 'string' ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(input.requestKey) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      throw new ImprovementConflictError('invalid');
    const connection = await this.database.openConnection();
    try {
      await connection.beginTransaction();
      try {
        const context = await this.#context(connection, input, true);
        const actor = createHash('sha256')
          .update(`${input.merchantId}:${input.assistantId}:${input.merchantUserId}`)
          .digest();
        const key = createHash('sha256').update(input.requestKey).digest();
        const { now: _now, requestKey: _requestKey, ...payload } = input;
        const hash = createHash('sha256')
          .update(JSON.stringify(canonical(payload)))
          .digest();
        const [previous] = await connection.execute<Row[]>(
          `SELECT request_hash, state, response_body FROM idempotency_record WHERE actor_scope_digest = ? AND operation = ? AND key_digest = ? LIMIT 1 FOR UPDATE`,
          [actor, operation, key],
        );
        if (previous[0]) {
          if (
            !Buffer.isBuffer(previous[0]['request_hash']) ||
            !hash.equals(previous[0]['request_hash']) ||
            previous[0]['state'] !== 'succeeded'
          )
            throw new ImprovementConflictError('idempotency_conflict');
          const body = previous[0]['response_body'];
          const response = restoreDates(
            typeof body === 'string' ? (JSON.parse(body) as unknown) : body,
          ) as T;
          await connection.commit();
          return replay ? replay(response) : response;
        }
        const idemId = randomBytes(16);
        await connection.execute(
          `INSERT INTO idempotency_record (id, merchant_id, actor_scope_digest, operation, key_digest, request_hash, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
          [
            idemId,
            id(input.merchantId),
            actor,
            operation,
            key,
            hash,
            new Date(input.now.getTime() + 7 * 86_400_000),
            input.now,
            input.now,
          ],
        );
        const response = await action(connection, context);
        await connection.execute(
          `UPDATE idempotency_record SET state = 'succeeded', response_body = ?, response_code = 200, updated_at = ? WHERE id = ? AND state = 'processing'`,
          [JSON.stringify(response), input.now, idemId],
        );
        const audit = auditTarget(input, response);
        await connection.execute(
          `INSERT INTO audit_log (id, merchant_id, actor_type, actor_id, action, target_type, target_id, result, request_id, metadata, occurred_at, created_at) VALUES (?, ?, 'merchant_user', ?, ?, 'assistant_improvement', ?, 'success', ?, ?, ?, ?)`,
          [
            randomBytes(16),
            id(input.merchantId),
            input.merchantUserId,
            operation,
            audit.improvementId,
            randomUUID(),
            JSON.stringify({
              assistantId: input.assistantId,
              improvementId: audit.improvementId,
              ...(audit.runId ? { runId: audit.runId } : {}),
            }),
            input.now,
            input.now,
          ],
        );
        await connection.commit();
        return response;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      await connection.end().catch(() => undefined);
    }
  }

  public async list(
    input: Omit<ImprovementActor, 'assistantId'> & { assistantId?: string },
  ): Promise<ImprovementList> {
    const connection = await this.database.openConnection();
    try {
      const [rows] = await connection.execute<Row[]>(
        `SELECT i.*, a.draft_revision, a.active_release_id, a.display_name, a.status AS assistant_status, d.config
           FROM assistant_improvement i
           JOIN assistant a ON a.merchant_id = i.merchant_id AND a.id = i.assistant_id
           JOIN assistant_draft d ON d.merchant_id = a.merchant_id AND d.assistant_id = a.id
           JOIN merchant m ON m.id = i.merchant_id AND m.status = 'active'
           JOIN merchant_membership mm ON mm.merchant_id = i.merchant_id AND mm.merchant_user_id = ? AND mm.status = 'active'
           JOIN merchant_user u ON u.id = mm.merchant_user_id AND u.status = 'active'
          WHERE i.merchant_id = ?${input.assistantId ? ' AND i.assistant_id = ?' : ''} ORDER BY i.updated_at DESC, i.id DESC`,
        [
          id(input.merchantUserId),
          id(input.merchantId),
          ...(input.assistantId ? [id(input.assistantId)] : []),
        ],
      );
      const [runRows] = await connection.execute<Row[]>(
        `SELECT r.* FROM assistant_evaluation_run r JOIN assistant_improvement i ON i.merchant_id = r.merchant_id AND i.assistant_id = r.assistant_id AND i.id = r.improvement_id JOIN merchant m ON m.id = r.merchant_id AND m.status = 'active' JOIN merchant_membership mm ON mm.merchant_id = r.merchant_id AND mm.merchant_user_id = ? AND mm.status = 'active' JOIN merchant_user u ON u.id = mm.merchant_user_id AND u.status = 'active' WHERE r.merchant_id = ?${input.assistantId ? ' AND r.assistant_id = ?' : ''} AND NOT EXISTS (SELECT 1 FROM assistant_evaluation_run newer WHERE newer.merchant_id = r.merchant_id AND newer.assistant_id = r.assistant_id AND newer.improvement_id = r.improvement_id AND (newer.created_at > r.created_at OR (newer.created_at = r.created_at AND newer.id > r.id)))`,
        [
          id(input.merchantUserId),
          id(input.merchantId),
          ...(input.assistantId ? [id(input.assistantId)] : []),
        ],
      );
      const latest = new Map(
        runRows.map((row) => {
          const run = parseRun(row);
          return [run.improvementId, run] as const;
        }),
      );
      const counts: Record<ImprovementState, number> = {
        needs_correction: 0,
        needs_evaluation: 0,
        needs_review: 0,
        failed: 0,
        ready_to_publish: 0,
        published: 0,
      };
      const items: AssistantImprovement[] = [];
      for (const row of rows) {
        const draft = parseAssistantDraft(row['config'] as string | Record<string, unknown>);
        const policy = this.#policy();
        const task = parseTask(
          row,
          {
            draft,
            revision: number(row['draft_revision']),
            hash: assistantFactsHash(draft),
            name: string(row['display_name']),
            status: string(row['assistant_status']),
            activeReleaseId: nullableHex(row['active_release_id']),
            ...(policy ? { policy } : {}),
          },
          latest.get(hex(row['id'])) ?? null,
        );
        counts[task.state]++;
        if (items.length < 50) items.push(task);
      }
      return { items, counts, total: rows.length, truncated: rows.length > 50 };
    } finally {
      await connection.end();
    }
  }
  public async detail(
    input: ImprovementActor & { improvementId: string },
  ): Promise<ImprovementDetail | null> {
    const connection = await this.database.openConnection();
    try {
      const context = await this.#context(connection, input, false);
      const row = await this.#task(connection, input, input.improvementId, false);
      const runs = await this.#runs(connection, input, input.improvementId);
      return {
        improvement: parseTask(row, context, runs[0] ?? null),
        runs,
        currentDraftRevision: context.revision,
        currentFactsHash: context.hash,
      };
    } catch (error) {
      if (error instanceof ImprovementConflictError && error.code === 'unavailable') return null;
      throw error;
    } finally {
      await connection.end();
    }
  }

  async #create(
    input: ImprovementWrite & ImprovementEdit & { sourceMessageId?: string },
  ): Promise<AssistantImprovement> {
    const edit = validateEdit(input);
    return this.#write('improvement.create', input, async (connection, context) => {
      let source: Row | undefined;
      if (input.sourceMessageId) {
        const [sources] = await connection.execute<Row[]>(
          `SELECT v.content, v.session_id, cs.release_id, (SELECT reply.content FROM message reply WHERE reply.merchant_id = v.merchant_id AND reply.assistant_id = v.assistant_id AND reply.session_id = v.session_id AND reply.turn_id = v.turn_id AND reply.role = 'assistant' AND reply.state = 'completed' ORDER BY reply.seq_no LIMIT 1) AS original_answer FROM message v JOIN conversation_session cs ON cs.merchant_id = v.merchant_id AND cs.assistant_id = v.assistant_id AND cs.id = v.session_id WHERE v.merchant_id = ? AND v.assistant_id = ? AND v.id = ? AND v.role = 'visitor' LIMIT 1`,
          [id(input.merchantId), id(input.assistantId), id(input.sourceMessageId)],
        );
        source = sources[0];
        if (!source) throw new ImprovementConflictError('unavailable');
        const [existing] = await connection.execute<Row[]>(
          `SELECT * FROM assistant_improvement WHERE merchant_id = ? AND assistant_id = ? AND source_message_id = ? LIMIT 1 FOR UPDATE`,
          [id(input.merchantId), id(input.assistantId), id(input.sourceMessageId)],
        );
        if (existing[0])
          return parseTask(
            existing[0],
            context,
            (await this.#runs(connection, input, hex(existing[0]['id'])))[0] ?? null,
          );
      }
      const question = source ? text(string(source['content']), 2_000) : edit.question;
      const improvementId = randomBytes(16);
      await connection.execute(
        `INSERT INTO assistant_improvement (id, merchant_id, assistant_id, version, source_session_id, source_message_id, source_release_id, reason, question, expected_answer, notes, original_answer, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          improvementId,
          id(input.merchantId),
          id(input.assistantId),
          source?.['session_id'] ?? null,
          input.sourceMessageId ? id(input.sourceMessageId) : null,
          source?.['release_id'] ?? null,
          edit.reason,
          question,
          edit.expectedAnswer,
          edit.notes,
          source?.['original_answer'] ?? null,
          id(input.merchantUserId),
          id(input.merchantUserId),
          input.now,
          input.now,
        ],
      );
      return this.#snapshot(connection, input, improvementId.toString('hex'), context);
    });
  }
  public async createFromMessage(
    input: ImprovementWrite & ImprovementEdit & { sourceMessageId: string },
  ): Promise<AssistantImprovement> {
    return this.#create(input);
  }
  public async createScenario(
    input: ImprovementWrite & ImprovementEdit,
  ): Promise<AssistantImprovement> {
    return this.#create(input);
  }
  public async update(
    input: ImprovementWrite & ImprovementEdit & { improvementId: string; expectedVersion: number },
  ): Promise<AssistantImprovement> {
    const edit = validateEdit(input);
    return this.#write('improvement.update', input, async (connection, context) => {
      const task = await this.#task(connection, input, input.improvementId, true);
      if (number(task['version']) !== input.expectedVersion)
        throw new ImprovementConflictError('stale');
      if (task['source_message_id'] != null && edit.question !== task['question'])
        throw new ImprovementConflictError('invalid');
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE assistant_improvement SET version = version + 1, reason = ?, question = ?, expected_answer = ?, notes = ?, applied_draft_revision = NULL, updated_by = ?, updated_at = ? WHERE merchant_id = ? AND assistant_id = ? AND id = ? AND version = ?`,
        [
          edit.reason,
          edit.question,
          edit.expectedAnswer,
          edit.notes,
          id(input.merchantUserId),
          input.now,
          id(input.merchantId),
          id(input.assistantId),
          id(input.improvementId),
          input.expectedVersion,
        ],
      );
      if (updated.affectedRows !== 1) throw new ImprovementConflictError('stale');
      return this.#snapshot(connection, input, input.improvementId, context);
    });
  }
  public async applyCorrection(
    input: ImprovementWrite & {
      improvementId: string;
      expectedVersion: number;
      expectedDraftRevision: number;
    },
  ): Promise<{ improvement: AssistantImprovement; draftRevision: number }> {
    return this.#write('improvement.apply', input, async (connection, context) => {
      const task = await this.#task(connection, input, input.improvementId, true);
      if (
        number(task['version']) !== input.expectedVersion ||
        context.revision !== input.expectedDraftRevision
      )
        throw new ImprovementConflictError('stale');
      const patch = applyImprovementFaq({
        materials: context.draft.materialsSummary,
        improvementId: input.improvementId,
        question: string(task['question']),
        expectedAnswer: string(task['expected_answer']),
        previousBlock: task['applied_block'] == null ? null : string(task['applied_block']),
      });
      if (
        patch.materials === context.draft.materialsSummary &&
        task['applied_draft_revision'] != null
      )
        return {
          improvement: await this.#snapshot(connection, input, input.improvementId, context),
          draftRevision: context.revision,
        };
      const draft = validateAssistantDraft({ ...context.draft, materialsSummary: patch.materials });
      const revision = context.revision + 1;
      const [draftResult] = await connection.execute<ResultSetHeader>(
        `UPDATE assistant_draft SET revision = ?, config = ?, validation = ?, updated_by = ?, updated_at = ? WHERE merchant_id = ? AND assistant_id = ? AND revision = ?`,
        [
          revision,
          JSON.stringify(draft),
          JSON.stringify({ publishable: false, reason: 'knowledge_not_verified' }),
          id(input.merchantUserId),
          input.now,
          id(input.merchantId),
          id(input.assistantId),
          context.revision,
        ],
      );
      const [assistantResult] = await connection.execute<ResultSetHeader>(
        `UPDATE assistant SET draft_revision = ?, updated_at = ? WHERE merchant_id = ? AND id = ? AND draft_revision = ?`,
        [revision, input.now, id(input.merchantId), id(input.assistantId), context.revision],
      );
      if (draftResult.affectedRows !== 1 || assistantResult.affectedRows !== 1)
        throw new ImprovementConflictError('stale');
      const [taskResult] = await connection.execute<ResultSetHeader>(
        `UPDATE assistant_improvement SET version = version + 1, applied_block = ?, applied_draft_revision = ?, updated_by = ?, updated_at = ? WHERE merchant_id = ? AND assistant_id = ? AND id = ? AND version = ?`,
        [
          patch.block,
          revision,
          id(input.merchantUserId),
          input.now,
          id(input.merchantId),
          id(input.assistantId),
          id(input.improvementId),
          input.expectedVersion,
        ],
      );
      if (taskResult.affectedRows !== 1) throw new ImprovementConflictError('stale');
      return {
        improvement: await this.#snapshot(connection, input, input.improvementId, {
          ...context,
          draft,
          revision,
          hash: assistantFactsHash(draft),
        }),
        draftRevision: revision,
      };
    });
  }
  public async startEvaluation(
    input: ImprovementWrite & {
      improvementId: string;
      expectedVersion: number;
      expectedDraftRevision: number;
      promptTemplateVersion: string;
      modelPolicyVersion: string;
    },
  ) {
    return this.#write(
      'improvement.evaluate.start',
      input,
      async (connection, context) => {
        const task = await this.#task(connection, input, input.improvementId, true);
        if (
          number(task['version']) !== input.expectedVersion ||
          context.revision !== input.expectedDraftRevision ||
          context.status === 'paused'
        )
          throw new ImprovementConflictError('stale');
        if (
          context.policy &&
          (input.promptTemplateVersion !== context.policy.promptTemplateVersion ||
            input.modelPolicyVersion !== context.policy.modelPolicyVersion)
        )
          throw new ImprovementConflictError('stale');
        const block = task['applied_block'];
        if (
          typeof block !== 'string' ||
          !context.draft.materialsSummary.includes(block) ||
          task['applied_draft_revision'] == null ||
          !string(task['expected_answer']).trim()
        )
          throw new ImprovementConflictError('invalid');
        const prior = (await this.#runs(connection, input, input.improvementId))[0];
        if (
          prior?.state === 'pending' &&
          prior.taskVersion === input.expectedVersion &&
          prior.draftRevision === context.revision &&
          prior.factsHash === context.hash &&
          prior.promptTemplateVersion === input.promptTemplateVersion &&
          prior.modelPolicyVersion === input.modelPolicyVersion
        ) {
          if (input.now.getTime() - prior.createdAt.getTime() < 120_000)
            return {
              run: prior,
              draft: context.draft,
              assistantName: context.name,
              started: false,
            };
          await connection.execute(
            `UPDATE assistant_evaluation_run SET state = 'failed', error_code = 'evaluation_interrupted', completed_at = ? WHERE merchant_id = ? AND assistant_id = ? AND improvement_id = ? AND id = ? AND state = 'pending'`,
            [
              input.now,
              id(input.merchantId),
              id(input.assistantId),
              id(input.improvementId),
              id(prior.id),
            ],
          );
        }
        const createdAt = new Date(
          Math.max(input.now.getTime(), prior ? prior.createdAt.getTime() + 1 : 0),
        );
        const runId = randomBytes(16);
        await connection.execute(
          `INSERT INTO assistant_evaluation_run (id, merchant_id, assistant_id, improvement_id, task_version, draft_revision, facts_hash, question, expected_answer, state, prompt_template_version, model_policy_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [
            runId,
            id(input.merchantId),
            id(input.assistantId),
            id(input.improvementId),
            input.expectedVersion,
            context.revision,
            Buffer.from(context.hash, 'hex'),
            task['question'],
            task['expected_answer'],
            text(input.promptTemplateVersion, 64),
            text(input.modelPolicyVersion, 64),
            id(input.merchantUserId),
            createdAt,
          ],
        );
        const [rows] = await connection.execute<Row[]>(
          `SELECT * FROM assistant_evaluation_run WHERE merchant_id = ? AND assistant_id = ? AND improvement_id = ? AND id = ? LIMIT 1`,
          [id(input.merchantId), id(input.assistantId), id(input.improvementId), runId],
        );
        if (!rows[0]) throw new ImprovementConflictError('unavailable');
        return {
          run: parseRun(rows[0]),
          draft: context.draft,
          assistantName: context.name,
          started: true,
        };
      },
      (response) => ({ ...response, started: false }),
    );
  }
  async #run(
    connection: Connection,
    input: ImprovementActor & { improvementId: string; runId: string },
  ): Promise<Row> {
    const [rows] = await connection.execute<Row[]>(
      `SELECT * FROM assistant_evaluation_run WHERE merchant_id = ? AND assistant_id = ? AND improvement_id = ? AND id = ? LIMIT 1 FOR UPDATE`,
      [id(input.merchantId), id(input.assistantId), id(input.improvementId), id(input.runId)],
    );
    if (!rows[0]) throw new ImprovementConflictError('unavailable');
    return rows[0];
  }
  public async finishEvaluation(
    input: ImprovementWrite & {
      improvementId: string;
      runId: string;
      answer: string | null;
      errorCode: string | null;
    },
  ): Promise<AssistantEvaluationRun> {
    if ((input.answer === null) === (input.errorCode === null))
      throw new ImprovementConflictError('invalid');
    if (input.answer !== null) text(input.answer, 8_000);
    if (input.errorCode !== null && !/^[a-z0-9_]{1,64}$/u.test(input.errorCode))
      throw new ImprovementConflictError('invalid');
    return this.#write('improvement.evaluate.finish', input, async (connection) => {
      await this.#task(connection, input, input.improvementId, true);
      const row = await this.#run(connection, input);
      if (row['state'] !== 'pending') {
        if (row['answer'] !== input.answer || row['error_code'] !== input.errorCode)
          throw new ImprovementConflictError('stale');
        return parseRun(row);
      }
      await connection.execute(
        `UPDATE assistant_evaluation_run SET state = ?, answer = ?, error_code = ?, completed_at = ? WHERE merchant_id = ? AND assistant_id = ? AND improvement_id = ? AND id = ? AND state = 'pending'`,
        [
          input.answer === null ? 'failed' : 'completed',
          input.answer,
          input.errorCode,
          input.now,
          id(input.merchantId),
          id(input.assistantId),
          id(input.improvementId),
          id(input.runId),
        ],
      );
      return parseRun(await this.#run(connection, input));
    });
  }
  public async reviewEvaluation(
    input: ImprovementWrite & {
      improvementId: string;
      runId: string;
      expectedVersion: number;
      expectedDraftRevision: number;
      verdict: 'pass' | 'fail';
    },
  ): Promise<AssistantEvaluationRun> {
    if (input.verdict !== 'pass' && input.verdict !== 'fail')
      throw new ImprovementConflictError('invalid');
    return this.#write('improvement.evaluate.review', input, async (connection, context) => {
      const task = await this.#task(connection, input, input.improvementId, true);
      const row = await this.#run(connection, input);
      const run = parseRun(row);
      const latest = (await this.#runs(connection, input, input.improvementId))[0];
      if (
        number(task['version']) !== input.expectedVersion ||
        context.revision !== input.expectedDraftRevision ||
        run.taskVersion !== input.expectedVersion ||
        run.draftRevision !== context.revision ||
        run.factsHash !== context.hash ||
        run.state !== 'completed' ||
        latest?.id !== run.id
      )
        throw new ImprovementConflictError('stale');
      if (
        context.policy &&
        (run.promptTemplateVersion !== context.policy.promptTemplateVersion ||
          run.modelPolicyVersion !== context.policy.modelPolicyVersion)
      )
        throw new ImprovementConflictError('stale');
      if (run.verdict !== null) {
        if (run.verdict !== input.verdict) throw new ImprovementConflictError('stale');
        return run;
      }
      await connection.execute(
        `UPDATE assistant_evaluation_run SET verdict = ?, reviewed_by = ?, reviewed_at = ? WHERE merchant_id = ? AND assistant_id = ? AND improvement_id = ? AND id = ? AND verdict IS NULL`,
        [
          input.verdict,
          id(input.merchantUserId),
          input.now,
          id(input.merchantId),
          id(input.assistantId),
          id(input.improvementId),
          id(input.runId),
        ],
      );
      return parseRun(await this.#run(connection, input));
    });
  }
}
