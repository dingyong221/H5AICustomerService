import type {
  RuntimeObservation,
  RuntimeObservationQuery,
  RuntimeTimingSummary,
} from '@h5cs/contracts';
import { RuntimeControlError } from '@h5cs/domain';
import type { RowDataPacket } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';
import { runtimeId, runtimeJobTypes } from './runtime-control-contract.js';
const number = (v: unknown) => {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new RuntimeControlError('UNAVAILABLE');
  return n;
};
const iso = (v: unknown): string | null =>
  v instanceof Date && Number.isFinite(v.getTime()) ? v.toISOString() : null;
function summary(
  values: number[],
  examinedCount: number,
  truncated: boolean,
): RuntimeTimingSummary {
  values.sort((a, b) => a - b);
  const at = (q: number) =>
    values.length ? values[Math.max(0, Math.ceil(values.length * q) - 1)]! : null;
  return {
    sampleCount: values.length,
    excludedCount: examinedCount - values.length,
    examinedCount,
    truncated,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: at(1),
  };
}
export class MySqlRuntimeObservationRepository {
  constructor(private readonly database: DatabaseConnectionConfig) {}
  async read(query: RuntimeObservationQuery): Promise<RuntimeObservation> {
    const { from, to, merchantId, type, cursor } = query,
      limit = query.limit ?? 20;
    if (
      !(from instanceof Date) ||
      !(to instanceof Date) ||
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > 31 * 86400000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (type && !runtimeJobTypes.includes(type))
    )
      throw new RuntimeControlError('INVALID_REQUEST');
    if (merchantId) runtimeId(merchantId);
    if (cursor) runtimeId(cursor);
    const c = await this.database.openConnection();
    try {
      const now = new Date(),
        params = [
          from,
          to,
          ...(merchantId ? [runtimeId(merchantId)] : []),
          ...(type ? [type] : []),
        ];
      const where = `j.created_at>=? AND j.created_at<? ${merchantId ? 'AND j.merchant_id=?' : ''} ${type ? 'AND j.type=?' : ''}`;
      const [groups] = await c.execute<RowDataPacket[]>(
        `SELECT j.state,COUNT(*) n, SUM(j.state='pending' AND j.run_after<=UTC_TIMESTAMP(6)) due, SUM(j.state='processing' AND j.lease_until<UTC_TIMESTAMP(6)) expired, MIN(CASE WHEN j.state='pending' THEN j.created_at END) oldest FROM job j WHERE ${where} GROUP BY j.state`,
        params,
      );
      const jobs = {
        pending: 0,
        duePending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        expiredLease: 0,
        oldestPendingAt: null as string | null,
      };
      let sampleCount = 0;
      for (const r of groups) {
        const n = number(r['n']);
        sampleCount += n;
        if (
          ['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(String(r['state']))
        )
          jobs[r['state'] as 'pending'] = n;
        jobs.duePending += number(r['due']);
        jobs.expiredLease += number(r['expired']);
        if (r['oldest']) jobs.oldestPendingAt = iso(r['oldest']);
      }
      const scopeWhere = `${merchantId ? 'AND a.merchant_id=?' : ''} ${type ? 'AND j.type=?' : ''}`;
      const scopeParams = [...(merchantId ? [runtimeId(merchantId)] : []), ...(type ? [type] : [])];
      const [attempts] = await c.execute<RowDataPacket[]>(
        `SELECT a.state,COUNT(*) n FROM model_call_attempt a LEFT JOIN job j ON j.id=a.job_id WHERE a.created_at>=? AND a.created_at<? ${scopeWhere} GROUP BY a.state`,
        [from, to, ...scopeParams],
      );
      const receipts = {
        dispatched: 0,
        unknown: 0,
        succeeded: 0,
        failed: 0,
        notDispatched: 0,
        unresolvedRiskCount: 0,
      };
      for (const r of attempts) {
        const k = r['state'] === 'not_dispatched' ? 'notDispatched' : String(r['state']);
        if (k in receipts) receipts[k as 'dispatched'] = number(r['n']);
      }
      const [risk] = await c.execute<RowDataPacket[]>(
        `SELECT COUNT(*) n FROM model_call_attempt a LEFT JOIN job j ON j.id=a.job_id WHERE a.state IN ('dispatched','unknown') ${scopeWhere}`,
        scopeParams,
      );
      receipts.unresolvedRiskCount = number(risk[0]?.['n']);
      const [reserved] = await c.execute<RowDataPacket[]>(
        `SELECT COALESCE(SUM(e.model_calls_reserved),0) n FROM marketplace_entitlement e WHERE EXISTS(SELECT 1 FROM marketplace_allocation a WHERE a.subject_digest=e.subject_digest AND a.product=e.product ${merchantId ? 'AND a.merchant_id=?' : ''})`,
        merchantId ? [runtimeId(merchantId)] : [],
      );
      const [allocated] = await c.execute<RowDataPacket[]>(
        `SELECT COUNT(DISTINCT merchant_id) n FROM marketplace_allocation ${merchantId ? 'WHERE merchant_id=?' : ''}`,
        merchantId ? [runtimeId(merchantId)] : [],
      );
      const [rows] = await c.execute<RowDataPacket[]>(
        `SELECT LOWER(HEX(j.id)) jobId,LOWER(HEX(j.merchant_id)) merchantId,j.type,j.state,j.model_outcome modelOutcome,j.attempt,CAST(j.claim_generation AS CHAR) claimGeneration,j.created_at createdAt,j.completed_at completedAt,j.last_error_code lastErrorCode FROM job j WHERE ${where} ${cursor ? 'AND j.id<?' : ''} ORDER BY j.id DESC LIMIT ${limit + 1}`,
        [...params, ...(cursor ? [runtimeId(cursor)] : [])],
      );
      const tasks = rows.slice(0, limit).map((r) => ({
        jobId: String(r['jobId']),
        merchantId: r['merchantId'] ? String(r['merchantId']) : null,
        type: String(r['type']),
        state: String(r['state']),
        modelOutcome: String(r['modelOutcome']),
        attempt: number(r['attempt']),
        claimGeneration: String(r['claimGeneration']),
        createdAt: iso(r['createdAt'])!,
        completedAt: iso(r['completedAt']),
        lastErrorCode: r['lastErrorCode'] ? String(r['lastErrorCode']) : null,
      }));
      const [timed] = await c.execute<RowDataPacket[]>(
        `SELECT j.created_at,j.completed_at,j.state,j.model_outcome,
        (SELECT MIN(a.created_at) FROM model_call_attempt a WHERE a.job_id=j.id AND a.claim_generation>0 AND a.state IN ('succeeded','failed')) dispatch_at
        FROM job j WHERE ${where} ORDER BY j.created_at DESC,j.id DESC LIMIT 1001`,
        params,
      );
      const complete: number[] = [],
        dispatch: number[] = [];
      for (const r of timed.slice(0, 1000)) {
        const start = r['created_at'] instanceof Date ? r['created_at'].getTime() : NaN;
        const known = !['unknown', 'dispatched'].includes(String(r['model_outcome']));
        const duration =
          r['completed_at'] instanceof Date ? r['completed_at'].getTime() - start : NaN;
        if (
          known &&
          ['completed', 'failed'].includes(String(r['state'])) &&
          duration >= 0 &&
          Number.isFinite(duration)
        )
          complete.push(duration);
        const until = r['dispatch_at'] instanceof Date ? r['dispatch_at'].getTime() - start : NaN;
        if (known && until >= 0 && Number.isFinite(until)) dispatch.push(until);
      }
      return {
        asOf: now.toISOString(),
        from: from.toISOString(),
        to: to.toISOString(),
        sampleCount,
        jobs,
        receipts,
        reservations: {
          reservedCalls: number(reserved[0]?.['n']),
          allocatedMerchantCount: number(allocated[0]?.['n']),
          unit: 'call_reservations_not_money',
        },
        tasks,
        nextCursor: rows.length > limit ? tasks.at(-1)!.jobId : null,
        timings: {
          acceptedToCompletedMs: summary(
            complete,
            Math.min(timed.length, 1000),
            timed.length > 1000,
          ),
          acceptedToDispatchRecordMs: summary(
            dispatch,
            Math.min(timed.length, 1000),
            timed.length > 1000,
          ),
        },
      };
    } catch (e) {
      if (e instanceof RuntimeControlError) throw e;
      throw new RuntimeControlError('UNAVAILABLE');
    } finally {
      await c.end();
    }
  }
}
