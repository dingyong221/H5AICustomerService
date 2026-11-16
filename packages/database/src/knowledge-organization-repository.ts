import { merchantJobTransaction, recoverMerchantJobs } from './persistent-merchant-job.js';
import { randomBytes } from 'node:crypto';
import { KnowledgeOrganizationError, safeKnowledgeRetry } from '@h5cs/domain';
import type { KnowledgeOrganizationResult, KnowledgeOrganizationTask } from '@h5cs/domain';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';
import type { ClaimMutationResult } from './conversation-job-contract.js';
import {
  authorizeKnowledgeScope,
  decodeKnowledgePayload,
  knowledgeBytes,
  knowledgeHash,
  knowledgeObject,
  knowledgeRevision,
  loadKnowledgeSources,
  lockKnowledgeJob,
  lockValidKnowledgeClaim,
  sameKnowledgeSources,
  type KnowledgeScope,
  type KnowledgeTaskPayload,
  type KnowledgeJobRow,
  type KnowledgeOrganizationClaim,
} from './knowledge-organization-contract.js';
export type {
  KnowledgeScope,
  KnowledgeOrganizationClaim,
} from './knowledge-organization-contract.js';
export { KnowledgeOrganizationError } from '@h5cs/domain';
export type { KnowledgeOrganizationTask } from '@h5cs/domain';

export type EnqueueKnowledgeOrganization = KnowledgeScope & {
  requestId: string;
  revision: number;
  sourceIds: readonly string[];
  consent: true;
  now: Date;
};
const validRequestId = (value: string) => {
  if (!/^organize_[a-f0-9]{32}$/u.test(value))
    throw new KnowledgeOrganizationError('INVALID_REQUEST');
};
const validNow = (now: Date) => {
  if (!Number.isFinite(now.getTime())) throw new KnowledgeOrganizationError('INVALID_REQUEST');
};
const digest = (scope: KnowledgeScope, requestId: string) =>
  knowledgeHash(JSON.stringify([scope.merchantId, scope.assistantId, scope.userId, requestId]));
export function parseKnowledgeResult(value: unknown): KnowledgeOrganizationResult {
  const x = knowledgeObject(value),
    summary = x['summary'],
    warnings = x['warnings'];
  const valid = (s: unknown, max: number): s is string =>
    typeof s === 'string' &&
    !!s.trim() &&
    s.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s);
  if (
    !valid(summary, 4000) ||
    !Array.isArray(warnings) ||
    warnings.length > 10 ||
    !warnings.every((s) => valid(s, 200))
  )
    throw new KnowledgeOrganizationError('INVALID_REQUEST');
  return { summary: summary.trim(), warnings: warnings as string[] };
}
export class MySqlKnowledgeOrganizationRepository {
  constructor(
    private readonly database: DatabaseConnectionConfig,
    private readonly enabled = process.env['KNOWLEDGE_ASYNC_ENABLED'] === 'true',
  ) {}
  async #assertSchema(c: Connection): Promise<void> {
    try {
      await c.execute('SELECT result FROM job LIMIT 0');
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_BAD_FIELD_ERROR')
        throw new KnowledgeOrganizationError('UNAVAILABLE');
      throw e;
    }
  }
  async #transaction<T>(run: (connection: Connection) => Promise<T>): Promise<T> {
    return merchantJobTransaction(
      this.database,
      () => new KnowledgeOrganizationError('WRITE_OUTCOME_UNKNOWN'),
      run,
    );
  }
  async #readJob(c: Connection, scope: KnowledgeScope, taskId: string): Promise<KnowledgeJobRow> {
    const [rows] = await c.execute<KnowledgeJobRow[]>(
      "SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE id=? AND merchant_id=? AND type='knowledge.organize'",
      [knowledgeBytes(taskId), knowledgeBytes(scope.merchantId)],
    );
    const r = rows[0];
    if (!r || decodeKnowledgePayload(r.payload).assistantId !== scope.assistantId)
      throw new KnowledgeOrganizationError('NOT_FOUND');
    return r;
  }
  async #view(
    c: Connection,
    scope: KnowledgeScope,
    row: KnowledgeJobRow,
  ): Promise<KnowledgeOrganizationTask> {
    const revision = await authorizeKnowledgeScope(c, scope),
      p = decodeKnowledgePayload(row.payload);
    let stale = revision !== p.inputRevision;
    try {
      const input = await loadKnowledgeSources(
        c,
        scope,
        p.sources.map((s) => s.id),
      );
      stale ||= !sameKnowledgeSources(input.sources, p.sources);
    } catch (e) {
      if (e instanceof KnowledgeOrganizationError && e.code === 'INPUT_CHANGED') stale = true;
      else throw e;
    }
    if (!['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(row.state))
      throw new KnowledgeOrganizationError('UNAVAILABLE');
    const stored = row.result === null ? null : knowledgeObject(row.result),
      appliedRevision = stored?.['appliedRevision'];
    if (row.state === 'completed' && (!stored || row.model_outcome !== 'succeeded'))
      throw new KnowledgeOrganizationError('UNAVAILABLE');
    if (appliedRevision !== undefined && !knowledgeRevision(appliedRevision))
      throw new KnowledgeOrganizationError('UNAVAILABLE');
    const canRetry = !stale && safeKnowledgeRetry(row.state, row.model_outcome);
    return {
      taskId: row.id.toString('hex'),
      state: row.state === 'pending' ? 'queued' : (row.state as KnowledgeOrganizationTask['state']),
      inputRevision: p.inputRevision,
      sources: p.sources,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      modelOutcome: row.model_outcome,
      stale,
      canRetry,
      canApply: row.state === 'completed' && !stale && appliedRevision === undefined,
      ...(row.state === 'completed' && stored ? { result: parseKnowledgeResult(stored) } : {}),
      ...(row.last_error_code ? { error: { code: row.last_error_code, retryable: canRetry } } : {}),
      ...(typeof appliedRevision === 'number' ? { appliedRevision } : {}),
    };
  }
  async get(scope: KnowledgeScope, taskId: string): Promise<KnowledgeOrganizationTask> {
    const c = await this.database.openConnection();
    try {
      await authorizeKnowledgeScope(c, scope);
      return await this.#view(c, scope, await this.#readJob(c, scope, taskId));
    } finally {
      await c.end();
    }
  }
  async findByRequest(
    scope: KnowledgeScope,
    requestId: string,
  ): Promise<KnowledgeOrganizationTask | null> {
    validRequestId(requestId);
    const c = await this.database.openConnection();
    try {
      await authorizeKnowledgeScope(c, scope);
      const [rows] = await c.execute<KnowledgeJobRow[]>(
        "SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE type='knowledge.organize' AND dedup_key=UNHEX(?)",
        [digest(scope, requestId)],
      );
      return rows[0] ? await this.#view(c, scope, rows[0]) : null;
    } finally {
      await c.end();
    }
  }
  async enqueue(input: EnqueueKnowledgeOrganization): Promise<KnowledgeOrganizationTask> {
    return this.#enqueue(input);
  }
  async #enqueue(
    input: EnqueueKnowledgeOrganization,
    retryOf?: string,
  ): Promise<KnowledgeOrganizationTask> {
    if (!this.enabled) throw new KnowledgeOrganizationError('UNAVAILABLE');
    validNow(input.now);
    validRequestId(input.requestId);
    for (const x of [input.merchantId, input.assistantId, input.userId]) knowledgeBytes(x);
    if (
      input.consent !== true ||
      !knowledgeRevision(input.revision) ||
      !Array.isArray(input.sourceIds) ||
      input.sourceIds.length < 1 ||
      input.sourceIds.length > 5 ||
      new Set(input.sourceIds).size !== input.sourceIds.length
    )
      throw new KnowledgeOrganizationError('INVALID_REQUEST');
    for (const x of input.sourceIds) knowledgeBytes(x);
    const requestHash = knowledgeHash(
      JSON.stringify({
        revision: input.revision,
        sourceIds: [...input.sourceIds].sort(),
        consent: true,
        retryOf: retryOf ?? null,
      }),
    );
    const taskId = await this.#transaction(async (c) => {
      const revision = await authorizeKnowledgeScope(c, input, true);
      await this.#assertSchema(c);
      const [existing] = await c.execute<KnowledgeJobRow[]>(
        "SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE type='knowledge.organize' AND dedup_key=UNHEX(?)",
        [digest(input, input.requestId)],
      );
      if (existing[0]) {
        const p = decodeKnowledgePayload(existing[0].payload);
        if (p.requestHash !== requestHash)
          throw new KnowledgeOrganizationError('IDEMPOTENCY_CONFLICT');
        return existing[0].id.toString('hex');
      }
      if (revision !== input.revision) throw new KnowledgeOrganizationError('INPUT_CHANGED');
      let retrySources: KnowledgeTaskPayload['sources'] | undefined;
      if (retryOf) {
        const previous = await lockKnowledgeJob(c, input, retryOf),
          p = decodeKnowledgePayload(previous.payload);
        if (
          !safeKnowledgeRetry(previous.state, previous.model_outcome) ||
          p.inputRevision !== input.revision ||
          JSON.stringify(p.sources.map((s) => s.id)) !== JSON.stringify([...input.sourceIds].sort())
        )
          throw new KnowledgeOrganizationError('RETRY_UNSAFE');
        retrySources = p.sources;
      }
      const source = await loadKnowledgeSources(c, input, input.sourceIds, true),
        jobId = randomBytes(16);
      if (retrySources && !sameKnowledgeSources(source.sources, retrySources))
        throw new KnowledgeOrganizationError('INPUT_CHANGED');
      const payload: KnowledgeTaskPayload = {
        schemaVersion: 1,
        handlerVersion: 'knowledge-organize-v1',
        merchantId: input.merchantId,
        assistantId: input.assistantId,
        requesterUserId: input.userId,
        inputRevision: input.revision,
        sources: source.sources,
        requestHash,
        ...(retryOf ? { retryOf } : {}),
      };
      await c.execute(
        "INSERT INTO job (id,merchant_id,type,dedup_key,payload,state,priority,attempt,max_attempts,run_after,created_at,updated_at) VALUES (?,?,'knowledge.organize',UNHEX(?),?,'pending',-10,0,5,?,?,?)",
        [
          jobId,
          knowledgeBytes(input.merchantId),
          digest(input, input.requestId),
          JSON.stringify(payload),
          input.now,
          input.now,
          input.now,
        ],
      );
      return jobId.toString('hex');
    });
    return this.get(input, taskId);
  }
  async retry(
    scope: KnowledgeScope,
    taskId: string,
    requestId: string,
    now: Date,
  ): Promise<KnowledgeOrganizationTask> {
    const previous = await this.get(scope, taskId);
    return this.#enqueue(
      {
        ...scope,
        requestId,
        revision: previous.inputRevision,
        sourceIds: previous.sources.map((s) => s.id),
        consent: true,
        now,
      },
      taskId,
    );
  }
  async cancel(
    scope: KnowledgeScope,
    taskId: string,
    now: Date,
  ): Promise<KnowledgeOrganizationTask> {
    validNow(now);
    await this.#transaction(async (c) => {
      await authorizeKnowledgeScope(c, scope, true);
      const row = await lockKnowledgeJob(c, scope, taskId);
      const result = row.result === null ? null : knowledgeObject(row.result);
      if (row.state === 'cancelled' || result?.['appliedRevision'] !== undefined) return;
      await c.execute(
        "UPDATE job SET state='cancelled',last_error_code='TASK_CANCELLED',lease_owner=NULL,lease_until=NULL,updated_at=?,completed_at=? WHERE id=?",
        [now, now, row.id],
      );
    });
    return this.get(scope, taskId);
  }
  async recoverExpired(now: Date): Promise<void> {
    validNow(now);
    await this.#transaction((c) => recoverMerchantJobs(c, ['knowledge.organize'], now));
  }
  async listRunnableMerchantHeads(
    now: Date,
    options: { limit?: number; afterMerchantId?: string } = {},
  ): Promise<readonly { merchantId: string; oldestReadyAt: Date }[]> {
    if (!this.enabled) return [];
    const probe = await this.database.openConnection();
    try {
      await this.#assertSchema(probe);
    } finally {
      await probe.end();
    }
    await this.recoverExpired(now);
    const limit = options.limit ?? 64;
    if (!Number.isInteger(limit) || limit < 1 || limit > 64)
      throw new KnowledgeOrganizationError('INVALID_REQUEST');
    const c = await this.database.openConnection();
    try {
      const params: (Date | Buffer)[] = [now];
      if (options.afterMerchantId) params.push(knowledgeBytes(options.afterMerchantId));
      const [rows] = await c.execute<(RowDataPacket & { merchant_id: Buffer; oldest: Date })[]>(
        `SELECT merchant_id,MIN(run_after) oldest FROM job WHERE type='knowledge.organize' AND state='pending' AND run_after<=? ${options.afterMerchantId ? 'AND merchant_id>?' : ''} GROUP BY merchant_id ORDER BY merchant_id LIMIT ${limit}`,
        params,
      );
      return rows.map((r) => ({
        merchantId: r.merchant_id.toString('hex'),
        oldestReadyAt: r.oldest,
      }));
    } finally {
      await c.end();
    }
  }
  async claimNext(
    now: Date,
    leaseOwner: string,
    options: { merchantId?: string } = {},
  ): Promise<KnowledgeOrganizationClaim | null> {
    if (!this.enabled) return null;
    validNow(now);
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(leaseOwner))
      throw new KnowledgeOrganizationError('INVALID_REQUEST');
    return this.#transaction(async (c) => {
      await this.#assertSchema(c);
      const params: (Date | Buffer)[] = [now];
      if (options.merchantId) params.push(knowledgeBytes(options.merchantId));
      const [candidates] = await c.execute<KnowledgeJobRow[]>(
        `SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE type='knowledge.organize' AND state='pending' AND run_after<=? ${options.merchantId ? 'AND merchant_id=?' : ''} ORDER BY run_after,id LIMIT 1`,
        params,
      );
      const candidate = candidates[0];
      if (!candidate) return null;
      let payload: KnowledgeTaskPayload;
      try {
        payload = decodeKnowledgePayload(candidate.payload);
      } catch {
        await c.execute(
          "UPDATE job SET state='failed',last_error_code='UNSUPPORTED_JOB_VERSION',updated_at=?,completed_at=? WHERE id=? AND state='pending'",
          [now, now, candidate.id],
        );
        return null;
      }
      const scope = {
        merchantId: payload.merchantId,
        assistantId: payload.assistantId,
        userId: payload.requesterUserId,
      };
      let revision: number;
      try {
        revision = await authorizeKnowledgeScope(c, scope, true);
      } catch (e) {
        if (!(e instanceof KnowledgeOrganizationError)) throw e;
        await c.execute(
          "UPDATE job SET state='failed',last_error_code='TASK_SCOPE_UNAVAILABLE',updated_at=?,completed_at=? WHERE id=? AND state='pending'",
          [now, now, candidate.id],
        );
        return null;
      }
      const row = await lockKnowledgeJob(c, scope, candidate.id.toString('hex'));
      if (row.state !== 'pending') return null;
      let text: string;
      try {
        const sources = await loadKnowledgeSources(
          c,
          scope,
          payload.sources.map((s) => s.id),
          true,
        );
        if (
          revision !== payload.inputRevision ||
          !sameKnowledgeSources(sources.sources, payload.sources)
        )
          throw new KnowledgeOrganizationError('INPUT_CHANGED');
        text = sources.text;
      } catch (e) {
        if (!(e instanceof KnowledgeOrganizationError)) throw e;
        await c.execute(
          "UPDATE job SET state='failed',last_error_code='INPUT_CHANGED',updated_at=?,completed_at=? WHERE id=?",
          [now, now, row.id],
        );
        return null;
      }
      if (row.model_outcome !== 'none' || row.attempt >= 5) {
        await c.execute(
          "UPDATE job SET state='failed',last_error_code='RETRY_UNSAFE',updated_at=?,completed_at=? WHERE id=?",
          [now, now, row.id],
        );
        return null;
      }
      const generation = BigInt(row.claim_generation) + 1n;
      if (generation > 18_446_744_073_709_551_615n)
        throw new KnowledgeOrganizationError('UNAVAILABLE');
      const leaseUntil = new Date(now.getTime() + 120000);
      await c.execute(
        "UPDATE job SET state='processing',attempt=attempt+1,claim_generation=?,lease_owner=?,lease_until=?,updated_at=? WHERE id=?",
        [generation.toString(), leaseOwner, leaseUntil, now, row.id],
      );
      return {
        jobId: row.id.toString('hex'),
        merchantId: payload.merchantId,
        assistantId: payload.assistantId,
        requesterUserId: payload.requesterUserId,
        leaseOwner,
        claimGeneration: generation.toString(),
        leaseUntil,
        payload,
        text,
      };
    });
  }
  async complete(
    claim: KnowledgeOrganizationClaim,
    result: KnowledgeOrganizationResult,
    now: Date,
  ): Promise<ClaimMutationResult> {
    const parsed = parseKnowledgeResult(result);
    return this.#mutate(claim, now, async (c, { job, payload, scope, revision }) => {
      let fresh = revision === payload.inputRevision;
      try {
        fresh &&= sameKnowledgeSources(
          (
            await loadKnowledgeSources(
              c,
              scope,
              payload.sources.map((s) => s.id),
              true,
            )
          ).sources,
          payload.sources,
        );
      } catch (e) {
        if (!(e instanceof KnowledgeOrganizationError)) throw e;
        fresh = false;
      }
      if (!fresh) {
        await this.#failLocked(c, job, 'INPUT_CHANGED', now);
        return;
      }
      if (job.model_outcome !== 'succeeded') throw new KnowledgeOrganizationError('TASK_NOT_READY');
      await c.execute(
        "UPDATE job SET state='completed',result=?,lease_owner=NULL,lease_until=NULL,last_error_code=NULL,updated_at=?,completed_at=? WHERE id=?",
        [JSON.stringify(parsed), now, now, job.id],
      );
    });
  }
  async fail(
    claim: KnowledgeOrganizationClaim,
    code: string,
    now: Date,
  ): Promise<ClaimMutationResult> {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(code))
      throw new KnowledgeOrganizationError('INVALID_REQUEST');
    return this.#mutate(claim, now, (c, { job }) => this.#failLocked(c, job, code, now));
  }
  async #failLocked(c: Connection, job: KnowledgeJobRow, code: string, now: Date) {
    await c.execute(
      "UPDATE job SET state='failed',last_error_code=?,lease_owner=NULL,lease_until=NULL,updated_at=?,completed_at=? WHERE id=?",
      [
        ['dispatched', 'unknown'].includes(job.model_outcome) ? 'MODEL_RESULT_UNKNOWN' : code,
        now,
        now,
        job.id,
      ],
    );
  }
  async releaseBeforeDispatch(
    claim: KnowledgeOrganizationClaim,
    now: Date,
  ): Promise<ClaimMutationResult> {
    return this.#mutate(claim, now, async (c, { job }) => {
      if (job.model_outcome !== 'none') throw new KnowledgeOrganizationError('STALE_CLAIM');
      await c.execute(
        "UPDATE job SET state='pending',lease_owner=NULL,lease_until=NULL,run_after=?,updated_at=? WHERE id=?",
        [now, now, job.id],
      );
    });
  }
  async #mutate(
    claim: KnowledgeOrganizationClaim,
    now: Date,
    run: (
      c: Connection,
      locked: Awaited<ReturnType<typeof lockValidKnowledgeClaim>>,
    ) => Promise<void>,
  ): Promise<ClaimMutationResult> {
    try {
      return await this.#transaction(async (c) => {
        const locked = await lockValidKnowledgeClaim(c, claim, now);
        await run(c, locked);
        return 'applied' as const;
      });
    } catch (e) {
      if (e instanceof KnowledgeOrganizationError && ['NOT_FOUND', 'STALE_CLAIM'].includes(e.code))
        return 'stale';
      throw e;
    }
  }
  async reconcile(claim: KnowledgeOrganizationClaim) {
    const c = await this.database.openConnection();
    try {
      const [rows] = await c.execute<KnowledgeJobRow[]>(
        "SELECT state,model_outcome,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE id=? AND merchant_id=? AND type='knowledge.organize' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.assistantId'))=?",
        [knowledgeBytes(claim.jobId), knowledgeBytes(claim.merchantId), claim.assistantId],
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
