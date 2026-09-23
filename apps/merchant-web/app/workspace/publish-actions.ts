'use server';

import { createHash } from 'node:crypto';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import {
  AssistantIdempotencyConflictError, AssistantPublishValidationError,
  AssistantRevisionConflictError, toAssistantId, toMerchantId, toMerchantUserId,
} from '@h5cs/domain';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { currentMerchantForWrite } from '../account/merchant-actions';
import { publicationPolicy, publicAssistantUrl } from './publication-policy';

export type PublishAssistantState = Readonly<{
  error: string | null;
  published: boolean;
  publicUrl: string | null;
  releaseNo: number | null;
}>;

const digest = (value: string): Uint8Array => createHash('sha256').update(value, 'utf8').digest();

export async function publishAssistantAction(
  _previous: PublishAssistantState,
  formData: FormData,
): Promise<PublishAssistantState> {
  const unavailable: PublishAssistantState = { error: '发布条件未满足。', published: false, publicUrl: null, releaseNo: null };
  const policy = publicationPolicy();
  if (!policy.ready) return { ...unavailable, error: policy.reason };
  const expectedOrigin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!expectedOrigin || (await headers()).get('origin') !== expectedOrigin) {
    return { ...unavailable, error: '请求来源校验失败。' };
  }
  const merchantId = formData.get('merchantId');
  const assistantId = formData.get('assistantId');
  const revisionText = formData.get('draftRevision');
  const idempotencyKey = formData.get('idempotencyKey');
  const csrfToken = formData.get('csrfToken');
  if (
    typeof merchantId !== 'string' || !/^[0-9a-f]{32}$/u.test(merchantId) ||
    typeof assistantId !== 'string' || !/^[0-9a-f]{32}$/u.test(assistantId) ||
    typeof revisionText !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(revisionText) ||
    typeof idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(idempotencyKey) ||
    typeof csrfToken !== 'string' || formData.get('publishConfirmed') !== 'yes'
  ) return { ...unavailable, error: '请确认当前草稿版本及发布影响。' };
  const merchant = await currentMerchantForWrite(merchantId, csrfToken);
  if (!merchant) return { ...unavailable, error: '登录或安全校验已失效，请重新登录。' };
  const database = loadDatabaseConfig();
  if (!database.configured) return { ...unavailable, error: '数据库尚未配置。' };
  const revision = Number(revisionText);
  const now = new Date();
  const repository = new MySqlAssistantLifecycleRepository(database.config);
  try {
    const assistant = await repository.findManagementSnapshot(
      toMerchantId(merchantId), toAssistantId(assistantId),
    );
    if (!assistant || assistant.draftRevision !== revision || !assistant.knowledgeConfirmed ||
        assistant.status === 'paused') {
      return { ...unavailable, error: '草稿或资料确认状态已变化，请刷新后重新检查。' };
    }
    const release = await repository.publish({
      merchantUserId: toMerchantUserId(merchant.merchantUserId),
      merchantId: toMerchantId(merchantId),
      assistantId: toAssistantId(assistantId),
      expectedDraftRevision: revision,
      promptTemplateVersion: policy.promptTemplateVersion,
      retrievalPolicyVersion: policy.retrievalPolicyVersion,
      modelPolicyVersion: policy.modelPolicyVersion,
      idempotency: {
        actorScopeDigest: digest(`${merchant.merchantUserId}:${merchantId}:assistant.publish`),
        keyDigest: digest(idempotencyKey),
        requestHash: digest(JSON.stringify({ merchantId, assistantId, revision,
          promptTemplateVersion: policy.promptTemplateVersion,
          retrievalPolicyVersion: policy.retrievalPolicyVersion,
          modelPolicyVersion: policy.modelPolicyVersion })),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      },
      now,
    });
    revalidatePath(`/workspace/${merchantId}/assistants/${assistantId}`);
    revalidatePath(`/workspace/${merchantId}`);
    const publicSnapshot = await repository.findPublicSnapshot(assistant.publicSlug);
    const publicUrl = publicSnapshot?.releaseRef === release.releaseId
      ? publicAssistantUrl(policy.consumerOrigin, assistant.publicSlug) : null;
    return {
      error: publicUrl ? null : '版本已发布，但公开配置校验暂未通过；请刷新后检查。',
      published: true, publicUrl, releaseNo: release.releaseNo,
    };
  } catch (error) {
    if (error instanceof AssistantPublishValidationError ||
        error instanceof AssistantRevisionConflictError ||
        error instanceof AssistantIdempotencyConflictError) {
      return { ...unavailable, error: '草稿状态已变化，请刷新并重新确认发布。' };
    }
    return { ...unavailable, error: '发布结果尚未确认，请刷新页面核对线上版本，勿连续重复提交。' };
  }
}
