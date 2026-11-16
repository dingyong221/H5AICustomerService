import type { Connection } from 'mysql2/promise';
import type { DatabaseConnectionConfig } from './config.js';
import type { KnowledgeJobRow } from './knowledge-organization-contract.js';
/** Shared transaction/recovery mechanics; job remains the only durable queue. */
export async function merchantJobTransaction<T>(
  database: DatabaseConnectionConfig,
  unknown: () => Error,
  run: (c: Connection) => Promise<T>,
): Promise<T> {
  const c = await database.openConnection();
  let committing = false;
  try {
    await c.beginTransaction();
    const result = await run(c);
    committing = true;
    await c.commit();
    return result;
  } catch (e) {
    await c.rollback().catch(() => undefined);
    if (committing) throw unknown();
    throw e;
  } finally {
    await c.end();
  }
}
export async function recoverMerchantJobs(
  c: Connection,
  types: readonly ('knowledge.organize' | 'draft.expand' | 'preview.reply')[],
  now: Date,
) {
  if (!types.length || !Number.isFinite(now.getTime())) throw Error('Invalid recovery scope');
  const [rows] = await c.execute<KnowledgeJobRow[]>(
    `SELECT *,CAST(claim_generation AS CHAR) claim_generation FROM job WHERE type IN (${types.map(() => '?').join(',')}) AND state='processing' AND lease_until<=? ORDER BY lease_until,id LIMIT 64 FOR UPDATE SKIP LOCKED`,
    [...types, now],
  );
  for (const row of rows) {
    if (row.model_outcome === 'none') {
      await c.execute(
        "UPDATE job SET state='pending',lease_owner=NULL,lease_until=NULL,run_after=?,updated_at=? WHERE id=?",
        [now, now, row.id],
      );
      continue;
    }
    const uncertain = ['dispatched', 'unknown'].includes(row.model_outcome);
    if (uncertain && row.model_attempt_id)
      await c.execute(
        "UPDATE model_call_attempt SET state='unknown',updated_at=?,completed_at=? WHERE id=? AND state='dispatched'",
        [now, now, row.model_attempt_id],
      );
    await c.execute(
      "UPDATE job SET state='failed',model_outcome=?,last_error_code=?,lease_owner=NULL,lease_until=NULL,updated_at=?,completed_at=? WHERE id=?",
      [
        uncertain ? 'unknown' : row.model_outcome,
        uncertain ? 'MODEL_RESULT_UNKNOWN' : 'RESULT_FINALIZATION_FAILED',
        now,
        now,
        row.id,
      ],
    );
  }
}
