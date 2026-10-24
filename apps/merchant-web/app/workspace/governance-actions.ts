'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId, toReleaseId } from '@h5cs/domain';

import { currentMerchantForWrite } from '../account/merchant-actions';

export type GovernanceActionState = Readonly<{ error: string | null; saved: boolean }>;
const failed = (error: string): GovernanceActionState => ({ error, saved: false });

async function authorized(formData: FormData) {
  const origin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!origin || (await headers()).get('origin') !== origin) return null;
  const merchantId = formData.get('merchantId');
  const assistantId = formData.get('assistantId');
  const csrfToken = formData.get('csrfToken');
  const revision = formData.get('draftRevision');
  if (
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    typeof assistantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(assistantId) ||
    typeof csrfToken !== 'string' ||
    typeof revision !== 'string' ||
    !/^[1-9][0-9]{0,9}$/u.test(revision)
  )
    return null;
  const member = await currentMerchantForWrite(merchantId, csrfToken);
  const database = loadDatabaseConfig();
  if (!member || !database.configured) return null;
  return {
    merchantId,
    assistantId,
    revision: Number(revision),
    merchantUserId: member.merchantUserId,
    repository: new MySqlAssistantLifecycleRepository(database.config),
  };
}

function refresh(merchantId: string, assistantId: string) {
  revalidatePath(`/${merchantId}`);
  for (const section of ['drafts', 'knowledge', 'preview', 'publish']) {
    revalidatePath(`/${merchantId}/${section}`);
    revalidatePath(`/${merchantId}/${section}/${assistantId}`);
  }
}

export async function renameAssistantAction(
  _previous: GovernanceActionState,
  formData: FormData,
): Promise<GovernanceActionState> {
  const context = await authorized(formData);
  const displayName = formData.get('displayName');
  if (!context) return failed('登录或安全校验已失效，请重新登录当前商家。');
  if (
    typeof displayName !== 'string' ||
    !displayName.trim() ||
    displayName.trim().length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(displayName)
  )
    return failed('请填写1至200字的客服名称，不要包含换行或控制字符。');
  try {
    await context.repository.renameAssistant({
      merchantUserId: toMerchantUserId(context.merchantUserId),
      merchantId: toMerchantId(context.merchantId),
      assistantId: toAssistantId(context.assistantId),
      expectedRevision: context.revision,
      displayName: displayName.trim(),
      now: new Date(),
    });
    refresh(context.merchantId, context.assistantId);
    return { error: null, saved: true };
  } catch {
    return failed('未能确认改名结果。请刷新核对名称和草稿修订，勿重复提交；固定客户链接不会更换。');
  }
}

export async function judgePreviewCheckAction(
  _previous: GovernanceActionState,
  formData: FormData,
): Promise<GovernanceActionState> {
  const context = await authorized(formData);
  if (!context) return failed('登录或安全校验已失效，请重新登录当前商家。');
  const checkId = formData.get('checkId');
  const verdict = formData.get('verdict');
  if (
    typeof checkId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(checkId) ||
    !['pass', 'fail'].includes(String(verdict)) ||
    formData.get('reviewConfirmed') !== 'yes'
  )
    return failed('请核对本修订的实际试聊回答，并明确选择通过或需要修改。');
  try {
    await context.repository.judgePreviewCheck({
      merchantUserId: toMerchantUserId(context.merchantUserId),
      merchantId: toMerchantId(context.merchantId),
      assistantId: toAssistantId(context.assistantId),
      expectedDraftRevision: context.revision,
      checkId,
      verdict: verdict as 'pass' | 'fail',
      now: new Date(),
    });
    refresh(context.merchantId, context.assistantId);
    return { error: null, saved: true };
  } catch {
    return failed('判定尚未确认，草稿或试聊记录可能已变化。请刷新核对本修订后再试。');
  }
}

export async function emergencyWithdrawAction(
  _previous: GovernanceActionState,
  formData: FormData,
): Promise<GovernanceActionState> {
  const context = await authorized(formData);
  if (!context) return failed('登录或安全校验已失效，请重新登录当前商家。');
  const releaseId = formData.get('expectedReleaseId');
  const reason = formData.get('reason');
  if (
    typeof releaseId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(releaseId) ||
    typeof reason !== 'string' ||
    reason.trim().length < 5 ||
    reason.trim().length > 500 ||
    /[\u0000-\u001f\u007f]/u.test(reason) ||
    formData.get('withdrawalConfirmed') !== 'yes'
  )
    return failed('请填写5至500字的撤回原因，并确认将停止当前及旧版本咨询。');
  try {
    await context.repository.emergencyWithdraw({
      merchantUserId: toMerchantUserId(context.merchantUserId),
      merchantId: toMerchantId(context.merchantId),
      assistantId: toAssistantId(context.assistantId),
      expectedReleaseId: toReleaseId(releaseId),
      reason: reason.trim(),
      now: new Date(),
    });
    refresh(context.merchantId, context.assistantId);
    return { error: null, saved: true };
  } catch {
    return failed('撤回结果尚未确认，线上版本可能已变化。请刷新检查服务状态，勿连续重复提交。');
  }
}
