import { RuntimeControlError, RuntimeExecutionBlockedError } from '@h5cs/domain';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeScope } from '@h5cs/contracts';
export const runtimeControlEnabled = () =>
  process.env['RUNTIME_EXECUTION_CONTROL_ENABLED'] === 'true';
export const runtimeJobTypes = [
  'conversation.turn',
  'knowledge.organize',
  'draft.expand',
  'preview.reply',
];
export const runtimeId = (id: string) => {
  if (!/^[a-f0-9]{32}$/u.test(id)) throw new RuntimeControlError('INVALID_REQUEST');
  return Buffer.from(id, 'hex');
};
export const runtimeScopeKey = (scope: RuntimeScope) =>
  scope.kind === 'global'
    ? 'global'
    : scope.kind === 'merchant'
      ? `merchant:${scope.merchantId}`
      : `job:${scope.jobId}`;
export type RuntimeRow = RowDataPacket & {
  scope_key: string;
  scope_type: string;
  merchant_id: Buffer | null;
  job_id: Buffer | null;
  state: string;
  revision: string;
  changed_at: Date | null;
  actor_id: string | null;
  reason: string | null;
  last_request_id: string | null;
};
const columns =
  'scope_key,scope_type,merchant_id,job_id,state,CAST(revision AS CHAR) revision,changed_at,actor_id,reason,last_request_id';
export async function readRuntimeRow(c: Connection, key: string, lock = false) {
  try {
    const [rows] = await c.execute<RuntimeRow[]>(
      `SELECT ${columns} FROM runtime_execution_control WHERE scope_key=?${lock ? ' FOR UPDATE' : ''}`,
      [key],
    );
    const r = rows[0];
    if (
      r &&
      (!['active', 'manually_stopped'].includes(r.state) ||
        !/^(0|[1-9][0-9]*)$/u.test(r.revision) ||
        BigInt(r.revision) > 18446744073709551615n ||
        !['global', 'merchant', 'job'].includes(r.scope_type))
    )
      throw new RuntimeControlError('UNAVAILABLE');
    return r;
  } catch (e) {
    if (e instanceof RuntimeControlError) throw e;
    throw new RuntimeControlError('UNAVAILABLE');
  }
}
/** Must be the FIRST lock in every guarded transaction. No HTTP while held. */
export async function lockRuntimeGate(c: Connection, enabled = runtimeControlEnabled()) {
  if (!enabled) return;
  const row = await readRuntimeRow(c, 'global', true);
  if (!row || row.scope_type !== 'global' || row.merchant_id !== null || row.job_id !== null)
    throw new RuntimeControlError('UNAVAILABLE');
}
export async function runtimeBlockers(
  c: Connection,
  input: { merchantId?: string; jobId?: string },
  lock = false,
): Promise<RuntimeScope[]> {
  const global = await readRuntimeRow(c, 'global', lock);
  if (
    !global ||
    global.scope_type !== 'global' ||
    global.merchant_id !== null ||
    global.job_id !== null
  )
    throw new RuntimeControlError('UNAVAILABLE');
  const scopes: RuntimeScope[] = [{ kind: 'global' }];
  if (input.merchantId) {
    runtimeId(input.merchantId);
    scopes.push({ kind: 'merchant', merchantId: input.merchantId });
  }
  if (input.jobId) {
    runtimeId(input.jobId);
    scopes.push({ kind: 'job', jobId: input.jobId });
  }
  const blocked: RuntimeScope[] = [];
  for (const scope of scopes) {
    const r =
      scope.kind === 'global' ? global : await readRuntimeRow(c, runtimeScopeKey(scope), lock);
    if (r) {
      if (
        r.scope_type !== scope.kind ||
        (scope.kind !== 'global' && r.merchant_id?.toString('hex') !== input.merchantId) ||
        (scope.kind === 'job' && r.job_id?.toString('hex') !== scope.jobId)
      )
        throw new RuntimeControlError('UNAVAILABLE');
      if (r.state === 'manually_stopped') blocked.push(scope);
    }
  }
  return blocked;
}
/** Caller already holds global. Check AFTER replay lookup but BEFORE new writes/fees. */
export async function assertRuntimeAllowed(
  c: Connection,
  input: { merchantId: string; jobId?: string },
  enabled = runtimeControlEnabled(),
) {
  if (enabled && (await runtimeBlockers(c, input, true)).length)
    throw new RuntimeExecutionBlockedError();
}
export async function probeRuntimeSchema(c: Connection, enabled = runtimeControlEnabled()) {
  if (enabled) await runtimeBlockers(c, {});
}
export function runtimeEligibleSql(alias = 'job', enabled = runtimeControlEnabled()) {
  if (!enabled) return '';
  if (!/^[a-z_]+$/u.test(alias)) throw new RuntimeControlError('INVALID_REQUEST');
  return ` AND NOT EXISTS (SELECT 1 FROM runtime_execution_control rc WHERE rc.state<>'active' AND
    (rc.scope_key='global' OR rc.scope_key=CONCAT('merchant:',LOWER(HEX(${alias}.merchant_id))) OR rc.scope_key=CONCAT('job:',LOWER(HEX(${alias}.id)))))`;
}
