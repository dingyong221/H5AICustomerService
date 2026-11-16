import { createHash, randomBytes } from 'node:crypto';
import { RuntimeControlError } from '@h5cs/domain';
import {
  runtimeControlRequestSchema,
  runtimeRequestIdSchema,
  runtimeScopeSchema,
  type RuntimeScope,
  type RuntimeControlRequest,
  type RuntimeControlReceipt,
  type RuntimeControlView,
  type ExecutionState,
} from '@h5cs/contracts';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';
import { merchantJobTransaction } from './persistent-merchant-job.js';
import {
  lockRuntimeGate,
  readRuntimeRow,
  runtimeBlockers,
  runtimeControlEnabled,
  runtimeId,
  runtimeJobTypes,
  runtimeScopeKey,
} from './runtime-control-contract.js';
export { RuntimeControlError, RuntimeExecutionBlockedError } from '@h5cs/domain';
const hash = (s: string) => createHash('sha256').update(s).digest();
const operator = (s: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(s))
    throw new RuntimeControlError('INVALID_REQUEST');
  return s;
};
const identity = (actor: string, key: string) => [
  hash(`runtime-operator:${operator(actor)}`),
  hash(key),
];
export class MySqlRuntimeExecutionControlRepository {
  constructor(
    private readonly database: DatabaseConnectionConfig,
    private readonly enabled = runtimeControlEnabled(),
  ) {}
  async #resolve(c: Connection, scope: RuntimeScope) {
    if (!runtimeScopeSchema.safeParse(scope).success)
      throw new RuntimeControlError('INVALID_REQUEST');
    if (scope.kind === 'global') return {};
    if (scope.kind === 'merchant') {
      const [r] = await c.execute<RowDataPacket[]>('SELECT id FROM merchant WHERE id=?', [
        runtimeId(scope.merchantId),
      ]);
      if (!r[0]) throw new RuntimeControlError('NOT_FOUND');
      return { merchantId: scope.merchantId };
    }
    const [r] = await c.execute<
      (RowDataPacket & { merchant_id: Buffer | null; type: string; state: string })[]
    >('SELECT merchant_id,type,state FROM job WHERE id=?', [runtimeId(scope.jobId)]);
    if (!r[0]) throw new RuntimeControlError('NOT_FOUND');
    if (!r[0].merchant_id || !runtimeJobTypes.includes(r[0].type))
      throw new RuntimeControlError('NOT_CONTROLLABLE');
    return {
      merchantId: r[0].merchant_id.toString('hex'),
      jobId: scope.jobId,
      jobState: r[0].state,
    };
  }
  async #receipt(c: Connection, actor: string, requestId: string) {
    const [r] = await c.execute<
      (RowDataPacket & {
        request_hash: Buffer;
        response_body: string | RuntimeControlReceipt;
        state: string;
      })[]
    >(
      "SELECT request_hash,response_body,state FROM idempotency_record WHERE actor_scope_digest=? AND key_digest=? AND operation='runtime.execution.control'",
      identity(actor, requestId),
    );
    return r[0];
  }
  async findReceipt(input: {
    operatorId: string;
    requestId: string;
  }): Promise<RuntimeControlReceipt | null> {
    if (!runtimeRequestIdSchema.safeParse(input.requestId).success)
      throw new RuntimeControlError('INVALID_REQUEST');
    const c = await this.database.openConnection();
    try {
      const r = await this.#receipt(c, input.operatorId, input.requestId);
      return r ? this.#decode(r) : null;
    } finally {
      await c.end();
    }
  }
  #decode(r: {
    state: string;
    response_body: string | RuntimeControlReceipt;
  }): RuntimeControlReceipt {
    if (r.state !== 'completed' || !r.response_body) throw new RuntimeControlError('UNAVAILABLE');
    return typeof r.response_body === 'string'
      ? (JSON.parse(r.response_body) as RuntimeControlReceipt)
      : r.response_body;
  }
  async change(
    input: RuntimeControlRequest & { operatorId: string; now: Date },
  ): Promise<RuntimeControlReceipt> {
    if (!this.enabled) throw new RuntimeControlError('DISABLED');
    const { operatorId, now, ...body } = input,
      parsed = runtimeControlRequestSchema.safeParse(body);
    if (!parsed.success || !Number.isFinite(now.getTime()))
      throw new RuntimeControlError('INVALID_REQUEST');
    operator(operatorId);
    const req = parsed.data,
      requestHash = hash(JSON.stringify(req)),
      key = runtimeScopeKey(req.scope);
    return merchantJobTransaction(
      this.database,
      () => new RuntimeControlError('WRITE_OUTCOME_UNKNOWN'),
      async (c) => {
        await lockRuntimeGate(c, true);
        const existing = await this.#receipt(c, operatorId, req.requestId);
        if (existing) {
          if (!existing.request_hash.equals(requestHash))
            throw new RuntimeControlError('IDEMPOTENCY_CONFLICT');
          return this.#decode(existing);
        }
        const resolved = await this.#resolve(c, req.scope);
        if (
          req.action === 'pause' &&
          resolved.jobState &&
          !['pending', 'processing'].includes(resolved.jobState)
        )
          throw new RuntimeControlError('NOT_CONTROLLABLE');
        const previous = await readRuntimeRow(c, key, true),
          revision = previous?.revision ?? '0';
        if (revision !== req.expectedRevision || BigInt(revision) === 18446744073709551615n)
          throw new RuntimeControlError('REVISION_CONFLICT');
        const next = (BigInt(revision) + 1n).toString(),
          state = req.action === 'pause' ? 'manually_stopped' : 'active',
          auditId = randomBytes(16);
        await c.execute(
          `INSERT INTO runtime_execution_control (scope_key,scope_type,merchant_id,job_id,state,revision,changed_at,actor_id,reason,last_request_id)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state),revision=VALUES(revision),changed_at=VALUES(changed_at),actor_id=VALUES(actor_id),reason=VALUES(reason),last_request_id=VALUES(last_request_id)`,
          [
            key,
            req.scope.kind,
            resolved.merchantId ? runtimeId(resolved.merchantId) : null,
            resolved.jobId ? runtimeId(resolved.jobId) : null,
            state,
            next,
            now,
            operatorId,
            req.reason,
            req.requestId,
          ],
        );
        const receipt: RuntimeControlReceipt = {
          requestId: req.requestId,
          scope: req.scope,
          scopeKey: key,
          action: req.action,
          previousRevision: revision,
          revision: next,
          state,
          changedAt: now.toISOString(),
          auditId: auditId.toString('hex'),
        };
        await c.execute(
          `INSERT INTO audit_log (id,merchant_id,actor_type,actor_id,action,target_type,target_id,result,request_id,reason,metadata,occurred_at,created_at)
        VALUES (?,?,'platform_operator',?,?,'runtime_execution_control',?,'success',?,?,?,?,?)`,
          [
            auditId,
            resolved.merchantId ? runtimeId(resolved.merchantId) : null,
            operatorId,
            `runtime.${req.action}`,
            key,
            req.requestId,
            req.reason,
            JSON.stringify({ previousRevision: revision, revision: next, state }),
            now,
            now,
          ],
        );
        await c.execute(
          `INSERT INTO idempotency_record (id,merchant_id,actor_scope_digest,operation,key_digest,request_hash,state,resource_type,response_code,response_body,expires_at,created_at,updated_at)
        VALUES (?,?,?,'runtime.execution.control',?,?,'completed','runtime_execution_control',200,?,?,?,?)`,
          [
            randomBytes(16),
            resolved.merchantId ? runtimeId(resolved.merchantId) : null,
            ...identity(operatorId, req.requestId),
            requestHash,
            JSON.stringify(receipt),
            new Date(now.getTime() + 30 * 86400000),
            now,
            now,
          ],
        );
        return receipt;
      },
    );
  }
  async read(scope: RuntimeScope): Promise<RuntimeControlView> {
    const c = await this.database.openConnection();
    try {
      const resolved = await this.#resolve(c, scope),
        key = runtimeScopeKey(scope);
      const row = this.enabled ? await readRuntimeRow(c, key) : undefined;
      const blocked = this.enabled ? await runtimeBlockers(c, resolved) : [];
      return {
        scope,
        scopeKey: key,
        enabled: this.enabled,
        state: row?.state === 'manually_stopped' ? 'manually_stopped' : 'active',
        revision: row?.revision ?? '0',
        changedAt: row?.changed_at?.toISOString() ?? null,
        actorId: row?.actor_id ?? null,
        reason: row?.reason ?? null,
        lastRequestId: row?.last_request_id ?? null,
        effectiveState: !this.enabled ? 'not-applicable' : blocked.length ? 'paused' : 'runnable',
        blockingScopes: blocked,
      };
    } finally {
      await c.end();
    }
  }
  async readEffective(input: {
    merchantId: string;
    jobId?: string;
    state?: string;
    modelOutcome?: string;
  }): Promise<ExecutionState> {
    if (
      !this.enabled ||
      (input.state && ['completed', 'failed', 'cancelled'].includes(input.state))
    )
      return 'not-applicable';
    try {
      const c = await this.database.openConnection();
      try {
        const blocked = await runtimeBlockers(c, input);
        return blocked.length
          ? input.modelOutcome === 'dispatched'
            ? 'draining'
            : 'paused'
          : 'runnable';
      } finally {
        await c.end();
      }
    } catch {
      return 'unavailable';
    }
  }
  async probe() {
    if (!this.enabled) return true;
    try {
      const c = await this.database.openConnection();
      try {
        await runtimeBlockers(c, {});
        return true;
      } finally {
        await c.end();
      }
    } catch {
      return false;
    }
  }
}
