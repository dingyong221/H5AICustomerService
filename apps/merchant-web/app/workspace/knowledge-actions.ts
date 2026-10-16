'use server';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { currentMerchant } from '../account/merchant-actions';
import { parseAssistantDraftForm } from './draft-form';

export type ConfirmKnowledgeState = Readonly<{ error: string | null; confirmed: boolean }>;
export type SaveDraftState = Readonly<{ error: string | null; saved: boolean }>;

export async function saveAssistantDraftAction(
  _previous: SaveDraftState,
  formData: FormData,
): Promise<SaveDraftState> {
  const expectedOrigin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!expectedOrigin || (await headers()).get('origin') !== expectedOrigin) {
    return { error: '请求来源校验失败。', saved: false };
  }
  const merchantId = formData.get('merchantId');
  const assistantId = formData.get('assistantId');
  const revisionValue = formData.get('draftRevision');
  const draft = parseAssistantDraftForm(formData);
  if (
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    typeof assistantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(assistantId) ||
    typeof revisionValue !== 'string' ||
    !/^[1-9][0-9]{0,9}$/u.test(revisionValue) ||
    !draft
  )
    return { error: '草稿参数无效，请检查字段。', saved: false };
  const session = await currentMerchant(merchantId);
  if (!session) return { error: '登录已失效或无权管理此商家。', saved: false };
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库尚未配置。', saved: false };
  try {
    await new MySqlAssistantLifecycleRepository(database.config).saveDraft({
      merchantUserId: toMerchantUserId(session.merchantUserId),
      merchantId: toMerchantId(merchantId),
      assistantId: toAssistantId(assistantId),
      expectedRevision: Number(revisionValue),
      draft,
      now: new Date(),
    });
    for (const section of ['drafts', 'knowledge', 'publish'])
      revalidatePath(`/${merchantId}/${section}/${assistantId}`);
    revalidatePath(`/${merchantId}`);
    revalidatePath(`/${merchantId}/drafts`);
    revalidatePath(`/${merchantId}/knowledge`);
    revalidatePath(`/${merchantId}/publish`);
    revalidatePath(`/${merchantId}/improvements`);
    revalidatePath('/[merchantId]/improvements/[improvementId]', 'page');
    return { error: null, saved: true };
  } catch {
    return { error: '保存失败，草稿可能已由其他页面更新。请刷新后重试。', saved: false };
  }
}

export async function confirmKnowledgeAction(
  _previous: ConfirmKnowledgeState,
  formData: FormData,
): Promise<ConfirmKnowledgeState> {
  const expectedOrigin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!expectedOrigin || (await headers()).get('origin') !== expectedOrigin) {
    return { error: '请求来源校验失败。', confirmed: false };
  }
  const merchantId = formData.get('merchantId');
  const assistantId = formData.get('assistantId');
  const revisionValue = formData.get('draftRevision');
  if (
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    typeof assistantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(assistantId) ||
    typeof revisionValue !== 'string' ||
    !/^[1-9][0-9]{0,9}$/u.test(revisionValue) ||
    formData.get('merchantConfirmed') !== 'yes'
  )
    return { error: '请阅读并确认当前资料。', confirmed: false };
  const session = await currentMerchant(merchantId);
  if (!session) return { error: '登录已失效或无权管理此商家。', confirmed: false };
  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库尚未配置。', confirmed: false };
  try {
    await new MySqlAssistantLifecycleRepository(database.config).confirmDraftKnowledge({
      merchantUserId: toMerchantUserId(session.merchantUserId),
      merchantId: toMerchantId(merchantId),
      assistantId: toAssistantId(assistantId),
      expectedDraftRevision: Number(revisionValue),
      now: new Date(),
    });
    for (const section of ['drafts', 'knowledge', 'publish'])
      revalidatePath(`/${merchantId}/${section}/${assistantId}`);
    revalidatePath(`/${merchantId}`);
    revalidatePath(`/${merchantId}/drafts`);
    revalidatePath(`/${merchantId}/knowledge`);
    revalidatePath(`/${merchantId}/publish`);
    revalidatePath(`/${merchantId}/improvements`);
    revalidatePath('/[merchantId]/improvements/[improvementId]', 'page');
    return { error: null, confirmed: true };
  } catch {
    return { error: '资料确认失败，草稿可能已变更。请刷新页面后重试。', confirmed: false };
  }
}
