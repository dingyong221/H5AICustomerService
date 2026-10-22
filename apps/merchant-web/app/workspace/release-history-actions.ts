'use server';

import {
  AssistantHistorySourceUnavailableError,
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
} from '@h5cs/database';
import {
  AssistantRevisionConflictError,
  toAssistantId,
  toMerchantId,
  toMerchantUserId,
  toReleaseId,
} from '@h5cs/domain';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { currentMerchantForWrite } from '../account/merchant-actions';

export type RestoreReleaseState = Readonly<{
  error: string | null;
  restored: Readonly<{ draftRevision: number; sourceReleaseNo: number }> | null;
}>;

export async function restoreReleaseToDraftAction(
  _previous: RestoreReleaseState,
  formData: FormData,
): Promise<RestoreReleaseState> {
  const failed = (error: string): RestoreReleaseState => ({ error, restored: null });
  const origin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!origin || (await headers()).get('origin') !== origin) return failed('请求来源校验失败。');
  const merchantId = formData.get('merchantId');
  const assistantId = formData.get('assistantId');
  const releaseId = formData.get('releaseId');
  const revision = formData.get('draftRevision');
  const csrf = formData.get('csrfToken');
  const id = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
  if (
    !id(merchantId) ||
    !id(assistantId) ||
    !id(releaseId) ||
    typeof revision !== 'string' ||
    !/^[1-9][0-9]{0,9}$/u.test(revision) ||
    typeof csrf !== 'string' ||
    formData.get('restoreConfirmed') !== 'yes'
  )
    return failed('请核对历史版本，并确认恢复到当前草稿。');
  const session = await currentMerchantForWrite(merchantId, csrf);
  if (!session) return failed('登录或安全校验已失效，请重新登录。');
  const database = loadDatabaseConfig();
  if (!database.configured) return failed('数据库暂不可用，当前资料未改变。');
  try {
    const result = await new MySqlAssistantLifecycleRepository(
      database.config,
    ).restoreDraftFromRelease({
      merchantId: toMerchantId(merchantId),
      assistantId: toAssistantId(assistantId),
      merchantUserId: toMerchantUserId(session.merchantUserId),
      releaseId: toReleaseId(releaseId),
      expectedRevision: Number(revision),
      now: new Date(),
    });
    if (
      result.assistant.merchantId !== merchantId ||
      result.assistant.assistantId !== assistantId ||
      result.assistant.draftRevision !== Number(revision) + 1 ||
      result.assistant.knowledgeConfirmed ||
      !Number.isSafeInteger(result.sourceReleaseNo) ||
      result.sourceReleaseNo < 1
    )
      return failed('恢复结果暂无法确认，请刷新草稿核对，不要重复提交。');
    for (const section of ['drafts', 'knowledge', 'preview', 'publish'])
      revalidatePath(`/${merchantId}/${section}/${assistantId}`);
    revalidatePath(`/${merchantId}/publish/${assistantId}/history`);
    revalidatePath(`/${merchantId}/publish/${assistantId}/history/${releaseId}`);
    revalidatePath(`/${merchantId}/drafts`);
    revalidatePath(`/${merchantId}/improvements`);
    revalidatePath('/[merchantId]/improvements/[improvementId]', 'page');
    return {
      error: null,
      restored: {
        draftRevision: result.assistant.draftRevision,
        sourceReleaseNo: result.sourceReleaseNo,
      },
    };
  } catch (error) {
    if (error instanceof AssistantRevisionConflictError)
      return failed('草稿或编辑权限已变化，请刷新并核对当前草稿；本次没有恢复。');
    if (error instanceof AssistantHistorySourceUnavailableError)
      return failed('所选历史版本不存在或无权访问，请返回发布历史重新选择。');
    return failed('恢复结果暂无法确认，请刷新草稿和历史记录核对，不要盲目重复提交。');
  }
}
