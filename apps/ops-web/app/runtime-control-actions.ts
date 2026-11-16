'use server';

import {
  runtimeControlRequestSchema,
  runtimeRequestIdSchema,
  runtimeScopeSchema,
  type RuntimeControlReceipt,
  type RuntimeControlView,
} from '@h5cs/contracts';
import {
  loadDatabaseConfig,
  MySqlRuntimeExecutionControlRepository,
  RuntimeControlError,
} from '@h5cs/database';
import { headers } from 'next/headers';
import { currentOperator } from './operator-actions';
import { loadOperatorAuthConfig } from './operator-auth';

export type RuntimeActionResult = {
  error: string | null;
  uncertain: boolean;
  receipt: RuntimeControlReceipt | null;
  current: RuntimeControlView | null;
};
const failed = (error: string, uncertain = false): RuntimeActionResult => ({
  error,
  uncertain,
  receipt: null,
  current: null,
});

// Every invocation, including reconciliation, uses the existing single operator
// session. Neither a scope ID nor a saved browser request grants authority.
export async function controlRuntime(input: unknown, lookup = false): Promise<RuntimeActionResult> {
  const config = loadOperatorAuthConfig();
  const operator = await currentOperator();
  if (!config || !operator || (await headers()).get('origin') !== config.publicOrigin)
    return failed('运营登录或请求来源无效。', lookup);
  const parsed = runtimeControlRequestSchema.safeParse(input);
  if (!parsed.success) return failed('请核对操作对象、修订号、原因与确认选项。', lookup);
  const request = parsed.data;
  if (
    !runtimeScopeSchema.safeParse(request.scope).success ||
    !runtimeRequestIdSchema.safeParse(request.requestId).success
  )
    return failed('操作标识无效。', lookup);
  if (!lookup && process.env['RUNTIME_EXECUTION_CONTROL_ENABLED'] !== 'true')
    return failed('运行控制未启用，暂不能修改；关闭开关不会清除已持久化的暂停。');
  const database = loadDatabaseConfig();
  if (!database.configured) return failed('运行控制数据库暂不可用。', lookup);
  const repository = new MySqlRuntimeExecutionControlRepository(database.config);
  let receipt: RuntimeControlReceipt | null = null;
  let error: string | null = null;
  let uncertain = lookup;
  try {
    if (lookup) {
      receipt = await repository.findReceipt({
        operatorId: operator,
        requestId: request.requestId,
      });
      if (!receipt) error = '尚未查到原操作收据。保留原请求编号，稍后再次查询；请勿新建操作重试。';
    } else {
      receipt = await repository.change({ ...request, operatorId: operator, now: new Date() });
    }
    if (receipt) uncertain = false;
  } catch (cause) {
    const code = cause instanceof RuntimeControlError ? cause.code : 'WRITE_OUTCOME_UNKNOWN';
    uncertain = lookup || code === 'WRITE_OUTCOME_UNKNOWN' || code === 'IDEMPOTENCY_CONFLICT';
    error =
      code === 'REVISION_CONFLICT'
        ? '状态修订已变化，本次未执行。请核对下方当前状态并刷新页面。'
        : code === 'IDEMPOTENCY_CONFLICT'
          ? '原请求编号已用于不同内容，请先查询原收据并核对当前状态。'
          : code === 'NOT_CONTROLLABLE' || code === 'NOT_FOUND'
            ? '此对象不存在或当前不能执行此项运行控制。'
            : code === 'DISABLED'
              ? '运行控制未启用，暂不能修改。'
              : uncertain
                ? '操作结果尚未确认。请查询原操作收据，不要用新编号重复提交。'
                : '运行控制暂不可用，请核对当前状态。';
  }
  let current: RuntimeControlView | null = null;
  try {
    current = await repository.read(request.scope);
  } catch {
    /* No false active state. */
  }
  return { receipt, current, uncertain, error };
}
