'use server';

import { createHash } from 'node:crypto';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { currentMerchant } from '../account/merchant-actions';

export type CreateAssistantState = Readonly<{
  error: string | null;
  created: { assistantId: string; displayName: string } | null;
}>;

const digest = (value: string): Uint8Array =>
  createHash('sha256').update(value, 'utf8').digest();

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
  ) return { error: '请求参数无效。', created: null };
  const session = await currentMerchant(merchantId);
  if (!session) return { error: '登录已失效或无权管理此商家。', created: null };

  const field = (name: string, maximum: number): string | null => {
    const value = formData.get(name);
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= maximum &&
      !/[\u0000-\u001f\u007f]/u.test(normalized)
      ? normalized : null;
  };
  const displayName = field('displayName', 200);
  const industry = field('industry', 128);
  const businessScope = field('businessScope', 2_000);
  const materialsSummary = field('materialsSummary', 4_000);
  const pricingSummary = field('pricingSummary', 4_000);
  const promotionSummary = field('promotionSummary', 4_000);
  const welcomeMessage = field('welcomeMessage', 500);
  const insufficientInfoMessage = field('insufficientInfoMessage', 500);
  if (
    !displayName || !industry || !businessScope || !materialsSummary ||
    !pricingSummary || !promotionSummary || !welcomeMessage || !insufficientInfoMessage
  ) return { error: '请填写所有业务资料，单项内容不能超过对应长度。', created: null };

  const database = loadDatabaseConfig();
  if (!database.configured) return { error: '数据库尚未配置。', created: null };
  const draft = {
    industry,
    businessScope,
    materialsSummary,
    pricingSummary,
    promotionSummary,
    welcomeMessage,
    insufficientInfoMessage,
  };
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
    revalidatePath(`/workspace/${merchantId}`);
    return { error: null, created: { assistantId: created.assistantId, displayName: created.displayName } };
  } catch {
    return { error: '客服草稿创建失败，请检查资料并稍后重试。', created: null };
  }
}
