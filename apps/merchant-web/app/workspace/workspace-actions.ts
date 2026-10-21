'use server';

import { createHash } from 'node:crypto';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { currentMerchant } from '../account/merchant-actions';
import { parseAssistantDraftForm } from './draft-form';

export type CreateAssistantState = Readonly<{
  error: string | null;
  created: { assistantId: string; displayName: string } | null;
}>;

const digest = (value: string): Uint8Array => createHash('sha256').update(value, 'utf8').digest();

export async function createAssistantDraft(
  _previous: CreateAssistantState,
  formData: FormData,
): Promise<CreateAssistantState> {
  const expectedOrigin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!expectedOrigin || (await headers()).get('origin') !== expectedOrigin) {
    return { error: '请求来源校验失败。', created: null };
  }
  const merchantId = formData.get('merchantId');
  const idempotencyKey = formData.get('idempotencyKey');
  if (
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    typeof idempotencyKey !== 'string' ||
    !/^[0-9a-f-]{36}$/u.test(idempotencyKey)
  )
    return { error: '请求参数无效。', created: null };
  const session = await currentMerchant(merchantId);
  if (!session) return { error: '登录已失效或无权管理此商家。', created: null };

  const displayNameValue = formData.get('displayName');
  const displayName = typeof displayNameValue === 'string' ? displayNameValue.trim() : '';
  const draft = parseAssistantDraftForm(formData);
  if (
    displayName.length === 0 ||
    displayName.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(displayName) ||
    !draft
  )
    return { error: '请填写所有业务资料，单项内容不能超过对应长度。', created: null };

  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库尚未配置。', created: null };
  const now = new Date();
  try {
    const repository = new MySqlAssistantLifecycleRepository(database.config);
    const created = await repository.createManualDraft({
      merchantUserId: toMerchantUserId(session.merchantUserId),
      merchantId: toMerchantId(merchantId),
      displayName,
      draft,
      idempotency: {
        actorScopeDigest: digest(`${session.merchantUserId}:${merchantId}:assistant.create_manual`),
        keyDigest: digest(idempotencyKey),
        requestHash: digest(JSON.stringify({ displayName, draft })),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      },
      now,
    });
    const persisted = await repository.findManagementSnapshot(
      toMerchantId(merchantId),
      created.assistantId,
    );
    if (!persisted || persisted.displayName !== created.displayName) {
      return { error: '后台未能核验保存结果，请保留当前资料并使用相同表单重试。', created: null };
    }
    revalidatePath(`/${merchantId}`);
    revalidatePath(`/${merchantId}/drafts`);
    revalidatePath(`/${merchantId}/knowledge`);
    revalidatePath(`/${merchantId}/preview`);
    revalidatePath(`/${merchantId}/publish`);
    return {
      error: null,
      created: { assistantId: created.assistantId, displayName: created.displayName },
    };
  } catch {
    return { error: '客服草稿创建失败，请检查资料并稍后重试。', created: null };
  }
}
