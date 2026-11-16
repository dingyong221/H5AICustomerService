import { randomBytes } from 'node:crypto';
import { AuthoringTaskError, safeKnowledgeRetry, type AuthoringTaskKind } from '@h5cs/domain';
import {
  authoringRequestIdSchema,
  authoringTaskSchema,
  draftExpandRequestSchema,
  previewReplyRequestSchema,
  parseWritingResult,
  type AuthoringTask,
  type DraftExpandRequest,
  type PreviewReplyRequest,
} from '@h5cs/contracts';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';
import type { ClaimMutationResult } from './conversation-job-contract.js';
import { knowledgeHash, type KnowledgeJobRow } from './knowledge-organization-contract.js';
import {
  authoringObject,
  authoringBytes,
  authorizeAuthoringScope,
  decodeAuthoringPayload,
  assertAuthoringInput,
  currentPreviewId,
  lockAuthoringJob,
  lockValidAuthoringClaim,
  type AuthoringScope,
  type AuthoringPayload,
  type AuthoringTaskClaim,
} from './authoring-task-contract.js';
import { merchantJobTransaction, recoverMerchantJobs } from './persistent-merchant-job.js';
import { persistPreviewCheck } from './publication-governance.js';
export { AuthoringTaskError } from '@h5cs/domain';
export type { AuthoringTask, DraftExpandTask, PreviewReplyTask } from '@h5cs/contracts';
export type { AuthoringScope, AuthoringTaskClaim } from './authoring-task-contract.js';
const kinds = ['draft.expand', 'preview.reply'] as const;
const validNow = (now: Date) => {
  if (!Number.isFinite(now.getTime())) throw new AuthoringTaskError('INVALID_REQUEST');
};
const validRequest = (id: string) => {
  if (!authoringRequestIdSchema.safeParse(id).success)
    throw new AuthoringTaskError('INVALID_REQUEST');
};
const dedup = (scope: AuthoringScope, kind: AuthoringTaskKind, key: string) =>
  knowledgeHash(
    JSON.stringify(['authoring', scope.merchantId, scope.assistantId, scope.userId, kind, key]),
  );
export class MySqlAuthoringTaskRepository {
  private readonly flags: { draftExpand: boolean; previewReply: boolean };
  constructor(
    private readonly database: DatabaseConnectionConfig,
    flags: { draftExpand?: boolean; previewReply?: boolean } = {},
  ) {
    this.flags = {
      draftExpand: flags.draftExpand ?? process.env['DRAFT_EXPAND_ASYNC_ENABLED'] === 'true',
      previewReply: flags.previewReply ?? process.env['PREVIEW_ASYNC_ENABLED'] === 'true',
    };
  }
  #enabled(kind: AuthoringTaskKind) {
    return kind === 'draft.expand' ? this.flags.draftExpand : this.flags.previewReply;
  }
  #tx<T>(run: (c: Connection) => Promise<T>) {
    return merchantJobTransaction(
      this.database,
      () => new AuthoringTaskError('WRITE_OUTCOME_UNKNOWN'),
      run,
    );
  }
  async #schema(c: Connection) {
    try {
      await c.execute('SELECT result FROM job LIMIT 0');
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_BAD_FIELD_ERROR')
        throw new AuthoringTaskError('UNAVAILABLE');
      throw e;
    }
  }
  async #read(c: Connection, scope: AuthoringScope, taskId: string) {
    const [rows] = await c.execute<KnowledgeJobRow[]>(
      "SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE id=? AND merchant_id=? AND type IN ('draft.expand','preview.reply')",
      [authoringBytes(taskId), authoringBytes(scope.merchantId)],
    );
    const row = rows[0];
    if (!row) throw new AuthoringTaskError('NOT_FOUND');
    const p = decodeAuthoringPayload(row.payload);
    if (
      p.assistantId !== scope.assistantId ||
      p.merchantId !== scope.merchantId ||
      row['type'] !== p.kind
    )
      throw new AuthoringTaskError('NOT_FOUND');
    return row;
  }
  async #view(c: Connection, scope: AuthoringScope, row: KnowledgeJobRow): Promise<AuthoringTask> {
    const current = await authorizeAuthoringScope(c, scope),
      p = decodeAuthoringPayload(row.payload);
    let stale = current.revision !== p.inputRevision;
    const stored = row.result === null ? null : authoringObject(row.result);
    if (row.state === 'completed' && (!stored || row.model_outcome !== 'succeeded'))
      throw new AuthoringTaskError('UNAVAILABLE');
    if (p.kind === 'preview.reply')
      stale ||=
        current.factsHash !== p.inputFactsHash ||
        (await currentPreviewId(c, scope)) !==
          (row.state === 'completed' ? stored?.['checkId'] : p.previousPreviewId);
    const canRetry = !stale && safeKnowledgeRetry(row.state, row.model_outcome);
    const base = {
      kind: p.kind,
      taskId: row.id.toString('hex'),
      state: row.state === 'pending' ? 'queued' : row.state,
      inputRevision: p.inputRevision,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      modelOutcome: row.model_outcome,
      stale,
      canRetry,
      ...(row.last_error_code ? { error: { code: row.last_error_code, retryable: canRetry } } : {}),
    };
    const result =
      p.kind === 'draft.expand'
        ? {
            ...base,
            kind: p.kind,
            field: p.input.field,
            inputFieldHash: p.inputFieldHash,
            canUse: row.state === 'completed' && !stale,
            ...(row.state === 'completed' ? { result: stored } : {}),
          }
        : {
            ...base,
            kind: p.kind,
            inputFactsHash: p.inputFactsHash,
            canJudge: row.state === 'completed' && !stale,
            ...(row.state === 'completed' ? { result: stored } : {}),
          };
    const parsed = authoringTaskSchema.safeParse(result);
    if (!parsed.success) throw new AuthoringTaskError('UNAVAILABLE');
    return parsed.data;
  }
  async get(scope: AuthoringScope, taskId: string) {
    const c = await this.database.openConnection();
    try {
      await authorizeAuthoringScope(c, scope);
      return await this.#view(c, scope, await this.#read(c, scope, taskId));
    } finally {
      await c.end();
    }
  }
  async findByRequest(scope: AuthoringScope, kind: AuthoringTaskKind, requestId: string) {
    validRequest(requestId);
    if (!kinds.includes(kind)) throw new AuthoringTaskError('INVALID_REQUEST');
    const c = await this.database.openConnection();
    try {
      await authorizeAuthoringScope(c, scope);
      const [rows] = await c.execute<KnowledgeJobRow[]>(
        'SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE type=? AND dedup_key=UNHEX(?)',
        [kind, dedup(scope, kind, requestId)],
      );
      return rows[0] ? await this.#view(c, scope, rows[0]) : null;
    } finally {
      await c.end();
    }
  }
  enqueueDraftExpand(input: AuthoringScope & DraftExpandRequest & { now: Date }) {
    const parsed = draftExpandRequestSchema.safeParse({
      requestId: input.requestId,
      revision: input.revision,
      field: input.field,
      brief: input.brief,
      currentText: input.currentText,
      consent: input.consent,
    });
    if (!parsed.success) throw new AuthoringTaskError('INVALID_REQUEST');
    return this.#enqueue(input, 'draft.expand', parsed.data, input.now);
  }
  enqueuePreviewReply(input: AuthoringScope & PreviewReplyRequest & { now: Date }) {
    const parsed = previewReplyRequestSchema.safeParse({
      requestId: input.requestId,
      revision: input.revision,
      question: input.question,
    });
    if (!parsed.success) throw new AuthoringTaskError('INVALID_REQUEST');
    return this.#enqueue(input, 'preview.reply', parsed.data, input.now);
  }
  async #enqueue(
    scope: AuthoringScope,
    kind: AuthoringTaskKind,
    input: DraftExpandRequest | PreviewReplyRequest,
    now: Date,
    retryOf?: string,
  ) {
    validNow(now);
    validRequest(input.requestId);
    if (!this.#enabled(kind)) throw new AuthoringTaskError('UNAVAILABLE');
    const requestHash = knowledgeHash(JSON.stringify({ kind, input, retryOf: retryOf ?? null }));
    const id = await this.#tx(async (c) => {
      const current = await authorizeAuthoringScope(c, scope, true);
      await this.#schema(c);
      const [existing] = await c.execute<KnowledgeJobRow[]>(
        'SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE type=? AND dedup_key=UNHEX(?)',
        [kind, dedup(scope, kind, input.requestId)],
      );
      if (existing[0]) {
        if (decodeAuthoringPayload(existing[0].payload).requestHash !== requestHash)
          throw new AuthoringTaskError('IDEMPOTENCY_CONFLICT');
        return existing[0].id.toString('hex');
      }
      if (current.revision !== input.revision) throw new AuthoringTaskError('INPUT_CHANGED');
      let previous: AuthoringPayload | undefined;
      if (retryOf) {
        const locked = await lockAuthoringJob(c, scope, retryOf);
        previous = locked.payload;
        if (
          previous.kind !== kind ||
          !safeKnowledgeRetry(locked.job.state, locked.job.model_outcome)
        )
          throw new AuthoringTaskError('RETRY_UNSAFE');
        await assertAuthoringInput(c, scope, previous, current);
      }
      const [count] = await c.execute<(RowDataPacket & { total: number })[]>(
        "SELECT COUNT(*) total FROM job WHERE merchant_id=? AND type IN ('draft.expand','preview.reply') AND state IN ('pending','processing')",
        [authoringBytes(scope.merchantId)],
      );
      if (Number(count[0]?.total) >= 4) throw new AuthoringTaskError('QUEUE_FULL');
      const common = {
        schemaVersion: 1 as const,
        merchantId: scope.merchantId,
        assistantId: scope.assistantId,
        requesterUserId: scope.userId,
        inputRevision: input.revision,
        requestHash,
        ...(retryOf ? { retryOf } : {}),
      };
      const payload: AuthoringPayload =
        kind === 'draft.expand'
          ? {
              ...common,
              kind,
              handlerVersion: 'draft-expand-v1',
              input: input as DraftExpandRequest,
              inputFieldHash: knowledgeHash((input as DraftExpandRequest).currentText),
            }
          : {
              ...common,
              kind,
              handlerVersion: 'preview-reply-v1',
              input: input as PreviewReplyRequest,
              inputFactsHash: current.factsHash,
              previousPreviewId: await currentPreviewId(c, scope, true),
            };
      const jobId = randomBytes(16);
      await c.execute(
        "INSERT INTO job (id,merchant_id,type,dedup_key,payload,state,priority,attempt,max_attempts,run_after,created_at,updated_at) VALUES (?,?,?,UNHEX(?),?,'pending',?,0,5,?,?,?)",
        [
          jobId,
          authoringBytes(scope.merchantId),
          kind,
          dedup(scope, kind, input.requestId),
          JSON.stringify(payload),
          kind === 'preview.reply' ? 0 : -10,
          now,
          now,
          now,
        ],
      );
      return jobId.toString('hex');
    });
    return this.get(scope, id);
  }
  async retry(scope: AuthoringScope, taskId: string, requestId: string, now: Date) {
    validRequest(requestId);
    const c = await this.database.openConnection();
    let p: AuthoringPayload;
    try {
      await authorizeAuthoringScope(c, scope);
      p = decodeAuthoringPayload((await this.#read(c, scope, taskId)).payload);
    } finally {
      await c.end();
    }
    return this.#enqueue(scope, p.kind, { ...p.input, requestId }, now, taskId);
  }
  async cancel(scope: AuthoringScope, taskId: string, now: Date) {
    validNow(now);
    await this.#tx(async (c) => {
      await authorizeAuthoringScope(c, scope, true);
      const { job, payload } = await lockAuthoringJob(c, scope, taskId);
      if (
        job.state === 'cancelled' ||
        (job.state === 'completed' && payload.kind === 'preview.reply')
      )
        return;
      await c.execute(
        "UPDATE job SET state='cancelled',last_error_code='TASK_CANCELLED',lease_owner=NULL,lease_until=NULL,updated_at=?,completed_at=? WHERE id=?",
        [now, now, job.id],
      );
    });
    return this.get(scope, taskId);
  }
  async recoverExpired(now: Date) {
    validNow(now);
    await this.#tx((c) => recoverMerchantJobs(c, kinds, now));
  }
  async listRunnableMerchantHeads(now: Date, options: { limit?: number; afterKey?: string } = {}) {
    const enabled = kinds.filter((k) => this.#enabled(k));
    if (!enabled.length) return [];
    const c = await this.database.openConnection();
    try {
      await this.#schema(c);
    } finally {
      await c.end();
    }
    await this.recoverExpired(now);
    const limit = options.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
      throw new AuthoringTaskError('INVALID_REQUEST');
    const read = await this.database.openConnection();
    try {
      const params: (string | Buffer | Date)[] = [...enabled, now];
      if (options.afterKey) {
        const [merchant, kind] = options.afterKey.split(':');
        if (!merchant || !kind || !kinds.includes(kind as AuthoringTaskKind))
          throw new AuthoringTaskError('INVALID_REQUEST');
        params.push(authoringBytes(merchant), authoringBytes(merchant), kind);
      }
      const [rows] = await read.execute<
        (RowDataPacket & { merchant_id: Buffer; type: AuthoringTaskKind; oldest: Date })[]
      >(
        `SELECT merchant_id,type,MIN(run_after) oldest FROM job WHERE type IN (${enabled.map(() => '?').join(',')}) AND state='pending' AND run_after<=? ${options.afterKey ? 'AND (merchant_id>? OR (merchant_id=? AND type>?))' : ''} GROUP BY merchant_id,type ORDER BY merchant_id,type LIMIT ${limit}`,
        params,
      );
      return rows.map((r) => ({
        merchantId: r.merchant_id.toString('hex'),
        kind: r.type,
        oldestReadyAt: r.oldest,
      }));
    } finally {
      await read.end();
    }
  }
  async claimNext(
    now: Date,
    owner: string,
    options: { merchantId: string; kind: AuthoringTaskKind },
  ): Promise<AuthoringTaskClaim | null> {
    validNow(now);
    if (!kinds.includes(options.kind) || !/^[A-Za-z0-9_-]{8,128}$/u.test(owner))
      throw new AuthoringTaskError('INVALID_REQUEST');
    if (!this.#enabled(options.kind)) return null;
    return this.#tx(async (c) => {
      await this.#schema(c);
      const [rows] = await c.execute<KnowledgeJobRow[]>(
        "SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE merchant_id=? AND type=? AND state='pending' AND run_after<=? ORDER BY run_after,id LIMIT 1",
        [authoringBytes(options.merchantId), options.kind, now],
      );
      const candidate = rows[0];
      if (!candidate) return null;
      let p: AuthoringPayload;
      try {
        p = decodeAuthoringPayload(candidate.payload);
        if (p.kind !== options.kind || p.merchantId !== options.merchantId)
          throw new AuthoringTaskError('INVALID_REQUEST');
      } catch {
        await c.execute(
          "UPDATE job SET state='failed',last_error_code='UNSUPPORTED_JOB_VERSION',updated_at=?,completed_at=? WHERE id=? AND state='pending'",
          [now, now, candidate.id],
        );
        return null;
      }
      const scope = {
        merchantId: p.merchantId,
        assistantId: p.assistantId,
        userId: p.requesterUserId,
      };
      let current: Awaited<ReturnType<typeof authorizeAuthoringScope>>;
      try {
        current = await authorizeAuthoringScope(c, scope, true);
      } catch (e) {
        if (!(e instanceof AuthoringTaskError)) throw e;
        await c.execute(
          "UPDATE job SET state='failed',last_error_code='TASK_SCOPE_UNAVAILABLE',updated_at=?,completed_at=? WHERE id=? AND state='pending'",
          [now, now, candidate.id],
        );
        return null;
      }
      const { job } = await lockAuthoringJob(c, scope, candidate.id.toString('hex'));
      if (job.state !== 'pending') return null;
      try {
        await assertAuthoringInput(c, scope, p, current);
      } catch (e) {
        if (!(e instanceof AuthoringTaskError)) throw e;
        await this.#failLocked(c, job, e.code, now);
        return null;
      }
      if (job.model_outcome !== 'none' || job.attempt >= 5) {
        await this.#failLocked(c, job, 'RETRY_UNSAFE', now);
        return null;
      }
      const generation = BigInt(job.claim_generation) + 1n;
      if (generation > 18446744073709551615n) throw new AuthoringTaskError('UNAVAILABLE');
      const leaseUntil = new Date(now.getTime() + 120000);
      await c.execute(
        "UPDATE job SET state='processing',attempt=attempt+1,claim_generation=?,lease_owner=?,lease_until=?,updated_at=? WHERE id=?",
        [generation.toString(), owner, leaseUntil, now, job.id],
      );
      return {
        jobId: job.id.toString('hex'),
        merchantId: p.merchantId,
        assistantId: p.assistantId,
        requesterUserId: p.requesterUserId,
        leaseOwner: owner,
        claimGeneration: generation.toString(),
        leaseUntil,
        payload: p,
        ...(p.kind === 'preview.reply'
          ? { facts: { assistantName: current.assistantName, draft: current.draft } }
          : {}),
      };
    });
  }
  async #mutate(
    claim: AuthoringTaskClaim,
    now: Date,
    run: (
      c: Connection,
      locked: Awaited<ReturnType<typeof lockValidAuthoringClaim>>,
    ) => Promise<void>,
  ): Promise<ClaimMutationResult> {
    try {
      return await this.#tx(async (c) => {
        const locked = await lockValidAuthoringClaim(c, claim, now);
        await run(c, locked);
        return 'applied' as const;
      });
    } catch (e) {
      if (e instanceof AuthoringTaskError && ['STALE_CLAIM', 'NOT_FOUND'].includes(e.code))
        return 'stale';
      throw e;
    }
  }
  async #failLocked(c: Connection, job: KnowledgeJobRow, code: string, now: Date) {
    await c.execute(
      "UPDATE job SET state='failed',last_error_code=?,lease_owner=NULL,lease_until=NULL,updated_at=?,completed_at=? WHERE id=?",
      [
        ['unknown', 'dispatched'].includes(job.model_outcome) ? 'MODEL_RESULT_UNKNOWN' : code,
        now,
        now,
        job.id,
      ],
    );
  }
  fail(claim: AuthoringTaskClaim, code: string, now: Date) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(code)) throw new AuthoringTaskError('INVALID_REQUEST');
    return this.#mutate(claim, now, (c, { job }) => this.#failLocked(c, job, code, now));
  }
  releaseBeforeDispatch(claim: AuthoringTaskClaim, now: Date) {
    return this.#mutate(claim, now, async (c, { job }) => {
      if (job.model_outcome !== 'none') throw new AuthoringTaskError('STALE_CLAIM');
      await c.execute(
        "UPDATE job SET state='pending',lease_owner=NULL,lease_until=NULL,run_after=?,updated_at=? WHERE id=?",
        [now, now, job.id],
      );
    });
  }
  complete(claim: AuthoringTaskClaim, result: unknown, now: Date) {
    return this.#mutate(claim, now, async (c, { job, payload, scope, current }) => {
      try {
        await assertAuthoringInput(c, scope, payload, current);
      } catch (e) {
        if (!(e instanceof AuthoringTaskError)) throw e;
        await this.#failLocked(c, job, e.code, now);
        return;
      }
      if (job.model_outcome !== 'succeeded') throw new AuthoringTaskError('TASK_NOT_READY');
      let stored: unknown;
      if (payload.kind === 'draft.expand') {
        stored = parseWritingResult(result, payload.input.field);
        if (!stored) throw new AuthoringTaskError('INVALID_REQUEST');
      } else {
        const x = authoringObject(result),
          answer = x['answer'];
        if (
          typeof answer !== 'string' ||
          !answer.trim() ||
          answer.length > 8000 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(answer)
        )
          throw new AuthoringTaskError('INVALID_REQUEST');
        if ((await currentPreviewId(c, scope, true)) !== payload.previousPreviewId) {
          await this.#failLocked(c, job, 'PREVIEW_SUPERSEDED', now);
          return;
        }
        const checkId = randomBytes(16);
        await persistPreviewCheck(
          c,
          {
            merchant: authoringBytes(scope.merchantId),
            assistant: authoringBytes(scope.assistantId),
            user: authoringBytes(scope.userId),
          },
          {
            checkId,
            revision: current.revision,
            factsHash: Buffer.from(current.factsHash, 'hex'),
            question: payload.input.question,
            answer: answer.trim(),
            now,
          },
        );
        const d = current.draft;
        const evidence = [
          { label: '细分行业', text: d.industry },
          { label: '业务范围', text: d.businessScope },
          { label: '商品与服务资料（含已保存的来源标记）', text: d.materialsSummary },
          { label: '价格与适用条件', text: d.pricingSummary },
          { label: '优惠与售卖策略', text: d.promotionSummary },
          { label: '人工联系说明', text: d.humanContact ?? '' },
        ].filter((x) => x.text.trim());
        stored = { answer: answer.trim(), checkId: checkId.toString('hex'), evidence };
      }
      await c.execute(
        "UPDATE job SET state='completed',result=?,lease_owner=NULL,lease_until=NULL,last_error_code=NULL,updated_at=?,completed_at=? WHERE id=?",
        [JSON.stringify(stored), now, now, job.id],
      );
    });
  }
  async reconcile(claim: AuthoringTaskClaim) {
    const c = await this.database.openConnection();
    try {
      const [rows] = await c.execute<KnowledgeJobRow[]>(
        "SELECT state,model_outcome,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE id=? AND merchant_id=? AND type=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.assistantId'))=?",
        [
          authoringBytes(claim.jobId),
          authoringBytes(claim.merchantId),
          claim.payload.kind,
          claim.assistantId,
        ],
      );
      const r = rows[0];
      return {
        state: r?.state ?? 'missing',
        currentGeneration: r?.claim_generation ?? null,
        modelOutcome: r?.model_outcome ?? 'none',
      };
    } finally {
      await c.end();
    }
  }
}
