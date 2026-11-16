import {
  authoringRequestIdSchema,
  authoringTaskSchema,
  authoringTaskCancelSchema,
  authoringTaskRetrySchema,
  draftExpandRequestSchema,
  previewReplyRequestSchema,
  EXECUTION_STATE_HEADER,
} from '@h5cs/contracts';
import {
  AuthoringTaskError,
  loadDatabaseConfig,
  MySqlAuthoringTaskRepository,
  MySqlRuntimeExecutionControlRepository,
  RuntimeExecutionBlockedError,
} from '@h5cs/database';
import { currentMerchant } from '../account/merchant-actions';
import { materialAccess, materialResponse, readMaterialBody } from '../knowledge/material-http';
import { withExecutionState } from './execution-response';

type Scope = { merchantId: string; assistantId: string; taskId?: string };
type Kind = 'draft.expand' | 'preview.reply';
type Operation = 'create' | 'find' | 'get' | 'retry' | 'cancel';
const id = (value: string | undefined) => !!value && /^[a-f0-9]{32}$/u.test(value);
const errors = {
  INVALID_REQUEST: [400, '请核对输入、草稿修订和确认选项。'],
  NOT_FOUND: [404, '任务不存在或无权访问。'],
  INPUT_CHANGED: [409, '草稿已变化，请核对当前修订。'],
  IDEMPOTENCY_CONFLICT: [409, '原请求已有不同内容，请刷新原任务核对。'],
  TASK_NOT_READY: [409, '任务尚未就绪，请刷新任务。'],
  RETRY_UNSAFE: [409, '无法确认调用结果，此任务不能重试。'],
  PREVIEW_SUPERSEDED: [409, '已有更新的试聊记录，请核对当前记录。'],
  QUEUE_FULL: [429, '正在处理的任务较多，请等待已有任务结束。'],
  UNAVAILABLE: [503, '生成服务暂不可用，请稍后查询原任务。'],
  WRITE_OUTCOME_UNKNOWN: [503, '尚未确认操作结果，请查询原任务，不要重复生成。'],
  STALE_CLAIM: [409, '任务状态已变化，请刷新核对。'],
} as const;
export async function authoringRoute(
  request: Request,
  scope: Scope,
  kind: Kind,
  operation: Operation,
) {
  try {
    if (
      !id(scope.merchantId) ||
      !id(scope.assistantId) ||
      (!['create', 'find'].includes(operation) && !id(scope.taskId))
    )
      throw new AuthoringTaskError('NOT_FOUND');
    const reading = operation === 'get' || operation === 'find';
    const access = reading ? null : await materialAccess(request, scope);
    const session = reading ? await currentMerchant(scope.merchantId) : access?.session;
    if (!session) throw new AuthoringTaskError('NOT_FOUND');
    const config = reading ? loadDatabaseConfig() : null;
    const database = access?.database ?? (config?.configured ? config.config : null);
    if (!database) throw new AuthoringTaskError('UNAVAILABLE');
    const repository = new MySqlAuthoringTaskRepository(database);
    const authorized = {
      merchantId: scope.merchantId,
      assistantId: scope.assistantId,
      userId: session.merchantUserId,
    };
    const checked = (value: unknown) => {
      const task = authoringTaskSchema.parse(value);
      if (task.kind !== kind) throw new AuthoringTaskError('NOT_FOUND');
      return task;
    };
    const respond = (status: number, task: ReturnType<typeof checked> | null) =>
      withExecutionState(materialResponse(status, task), () =>
        task
          ? repository.getExecutionState(authorized, task.taskId)
          : new MySqlRuntimeExecutionControlRepository(database).readEffective({
              merchantId: authorized.merchantId,
            }),
      );
    if (operation === 'get')
      return respond(200, checked(await repository.get(authorized, scope.taskId!)));
    if (operation === 'find') {
      const requestId = authoringRequestIdSchema.safeParse(
        new URL(request.url).searchParams.get('requestId'),
      );
      if (!requestId.success) throw new AuthoringTaskError('INVALID_REQUEST');
      const task = await repository.findByRequest(authorized, kind, requestId.data);
      return respond(200, task ? checked(task) : null);
    }
    let body: unknown;
    try {
      body = JSON.parse(
        (await readMaterialBody(request, operation === 'create' ? 25000 : 1000)).toString('utf8'),
      );
    } catch {
      throw new AuthoringTaskError('INVALID_REQUEST');
    }
    const now = new Date();
    let task;
    if (operation === 'create') {
      if (kind === 'draft.expand') {
        const parsed = draftExpandRequestSchema.safeParse(body);
        if (!parsed.success) throw new AuthoringTaskError('INVALID_REQUEST');
        task = await repository.enqueueDraftExpand({ ...authorized, ...parsed.data, now });
      } else {
        const parsed = previewReplyRequestSchema.safeParse(body);
        if (!parsed.success) throw new AuthoringTaskError('INVALID_REQUEST');
        task = await repository.enqueuePreviewReply({ ...authorized, ...parsed.data, now });
      }
    } else {
      // Check the immutable kind before invoking a mutation through this route.
      checked(await repository.get(authorized, scope.taskId!));
      if (operation === 'retry') {
        const parsed = authoringTaskRetrySchema.safeParse(body);
        if (!parsed.success) throw new AuthoringTaskError('INVALID_REQUEST');
        task = await repository.retry(authorized, scope.taskId!, parsed.data.requestId, now);
      } else {
        if (!authoringTaskCancelSchema.safeParse(body).success)
          throw new AuthoringTaskError('INVALID_REQUEST');
        task = await repository.cancel(authorized, scope.taskId!, now);
      }
    }
    return respond(operation === 'cancel' ? 200 : 202, checked(task));
  } catch (error) {
    if (error instanceof RuntimeExecutionBlockedError) {
      const response = materialResponse(503, {
        code: 'UNAVAILABLE',
        error: '生成服务已暂停，原任务和输入已保留。请稍后查询原任务。',
      });
      response.headers.set(EXECUTION_STATE_HEADER, 'paused');
      return response;
    }
    const code =
      error instanceof AuthoringTaskError
        ? error.code
        : operation === 'get' || operation === 'find'
          ? 'UNAVAILABLE'
          : 'WRITE_OUTCOME_UNKNOWN';
    const [status, message] = errors[code];
    return materialResponse(status, { code, error: message });
  }
}
