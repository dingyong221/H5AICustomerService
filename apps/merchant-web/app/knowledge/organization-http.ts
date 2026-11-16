import {
  knowledgeOrganizationApplySchema,
  knowledgeOrganizationCancelSchema,
  knowledgeOrganizationRequestIdSchema,
  knowledgeOrganizationRequestSchema,
  knowledgeOrganizationRetrySchema,
  knowledgeOrganizationTaskSchema,
} from '@h5cs/contracts';
import {
  KnowledgeOrganizationError,
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlKnowledgeOrganizationRepository,
} from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { revalidatePath } from 'next/cache';
import { currentMerchant } from '../account/merchant-actions';
import { materialAccess, materialResponse, readMaterialBody } from './material-http';

type Scope = { merchantId: string; assistantId: string; taskId?: string };
type Operation = 'create' | 'get' | 'find' | 'cancel' | 'retry' | 'apply';
const id = (value: string | undefined) => !!value && /^[a-f0-9]{32}$/u.test(value);
const missing = () => materialResponse(404, { code: 'NOT_FOUND', error: '任务不存在或无权访问。' });
const errors = {
  INVALID_REQUEST: [400, '请核对材料、草稿修订及确认选项；追加后的资料不能超过 4000 字。'],
  NOT_FOUND: [404, '任务不存在或无权访问。'],
  INPUT_CHANGED: [409, '草稿或来源材料已变化，请重新整理并核对。'],
  IDEMPOTENCY_CONFLICT: [409, '这次操作已有不同内容，请刷新核对任务和草稿。'],
  TASK_NOT_READY: [409, '任务尚不可采纳，请刷新查看当前进度。'],
  RETRY_UNSAFE: [409, '无法确认模型调用结果，此任务不能重试。'],
  UNAVAILABLE: [503, '整理服务暂不可用，请稍后查询任务。'],
  WRITE_OUTCOME_UNKNOWN: [503, '尚未确认操作结果，请查询原任务；不会自动重新提交。'],
  STALE_CLAIM: [409, '任务状态已变化，请刷新核对。'],
} as const;

// GET uses the existing session without requiring a write Origin or CSRF header.
// The repository independently checks current assistant and editable membership.
export async function organizationRoute(request: Request, scope: Scope, operation: Operation) {
  try {
    if (
      !id(scope.merchantId) ||
      !id(scope.assistantId) ||
      (!['create', 'find'].includes(operation) && !id(scope.taskId))
    )
      return missing();
    const reading = operation === 'get' || operation === 'find';
    const access = reading ? null : await materialAccess(request, scope);
    const session = reading ? await currentMerchant(scope.merchantId) : access?.session;
    if (!session) return missing();
    const config = reading ? loadDatabaseConfig() : null;
    const database = access?.database ?? (config?.configured ? config.config : null);
    if (!database) throw new KnowledgeOrganizationError('UNAVAILABLE');
    const repository = new MySqlKnowledgeOrganizationRepository(database);
    const authorized = {
      merchantId: scope.merchantId,
      assistantId: scope.assistantId,
      userId: session.merchantUserId,
    };
    if (reading) {
      if (operation === 'get')
        return materialResponse(
          200,
          knowledgeOrganizationTaskSchema.parse(await repository.get(authorized, scope.taskId!)),
        );
      const requestId = knowledgeOrganizationRequestIdSchema.safeParse(
        new URL(request.url).searchParams.get('requestId'),
      );
      if (!requestId.success) throw new KnowledgeOrganizationError('INVALID_REQUEST');
      const task = await repository.findByRequest(authorized, requestId.data);
      return materialResponse(200, task ? knowledgeOrganizationTaskSchema.parse(task) : null);
    }
    let body: unknown;
    try {
      body = JSON.parse(
        (await readMaterialBody(request, operation === 'apply' ? 20000 : 2000)).toString('utf8'),
      );
    } catch {
      throw new KnowledgeOrganizationError('INVALID_REQUEST');
    }
    const now = new Date();
    if (operation === 'apply') {
      const parsed = knowledgeOrganizationApplySchema.safeParse(body);
      if (!parsed.success) throw new KnowledgeOrganizationError('INVALID_REQUEST');
      const saved = await new MySqlAssistantLifecycleRepository(
        database,
      ).applyKnowledgeOrganization({
        merchantId: toMerchantId(scope.merchantId),
        assistantId: toAssistantId(scope.assistantId),
        merchantUserId: toMerchantUserId(session.merchantUserId),
        taskId: scope.taskId!,
        expectedRevision: parsed.data.revision,
        summary: parsed.data.summary,
        mode: parsed.data.mode,
        confirmed: true,
        now,
      });
      for (const section of ['drafts', 'knowledge', 'preview', 'publish']) {
        revalidatePath(`/${scope.merchantId}/${section}`);
        revalidatePath(`/${scope.merchantId}/${section}/${scope.assistantId}`);
      }
      revalidatePath(`/${scope.merchantId}`);
      return materialResponse(200, saved);
    }
    let task;
    if (operation === 'create') {
      const parsed = knowledgeOrganizationRequestSchema.safeParse(body);
      if (!parsed.success) throw new KnowledgeOrganizationError('INVALID_REQUEST');
      task = await repository.enqueue({ ...authorized, ...parsed.data, now });
    } else if (operation === 'retry') {
      const parsed = knowledgeOrganizationRetrySchema.safeParse(body);
      if (!parsed.success) throw new KnowledgeOrganizationError('INVALID_REQUEST');
      task = await repository.retry(authorized, scope.taskId!, parsed.data.requestId, now);
    } else {
      if (!knowledgeOrganizationCancelSchema.safeParse(body).success)
        throw new KnowledgeOrganizationError('INVALID_REQUEST');
      task = await repository.cancel(authorized, scope.taskId!, now);
    }
    return materialResponse(
      operation === 'cancel' ? 200 : 202,
      knowledgeOrganizationTaskSchema.parse(task),
    );
  } catch (error) {
    const code =
      error instanceof KnowledgeOrganizationError
        ? error.code
        : operation === 'get' || operation === 'find'
          ? 'UNAVAILABLE'
          : 'WRITE_OUTCOME_UNKNOWN';
    const [status, message] = errors[code];
    return materialResponse(status, { code, error: message });
  }
}
