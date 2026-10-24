'use server';

import { createHash } from 'node:crypto';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import {
  AssistantIdempotencyConflictError,
  AssistantPublishValidationError,
  AssistantRevisionConflictError,
  toAssistantId,
  toMerchantId,
  toMerchantUserId,
} from '@h5cs/domain';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import { currentMerchantForWrite } from '../account/merchant-actions';
import { publicApiReady } from './api-readiness';
import { publicationPolicy, publicAssistantUrl } from './publication-policy';
import { workerReady } from './worker-readiness';

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
  return publishCurrentDraft(formData, false);
}

export async function confirmAndPublishAssistantAction(
  _previous: PublishAssistantState,
  formData: FormData,
): Promise<PublishAssistantState> {
  return publishCurrentDraft(formData, true);
}

async function publishCurrentDraft(
  formData: FormData,
  confirmAndPublish: boolean,
): Promise<PublishAssistantState> {
  const unavailable: PublishAssistantState = {
    error: '发布条件未满足。',
    published: false,
    publicUrl: null,
    releaseNo: null,
  };
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
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    typeof assistantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(assistantId) ||
    typeof revisionText !== 'string' ||
    !/^[1-9][0-9]{0,9}$/u.test(revisionText) ||
    typeof idempotencyKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(idempotencyKey) ||
    typeof csrfToken !== 'string' ||
    formData.get(confirmAndPublish ? 'confirmAndPublish' : 'publishConfirmed') !== 'yes'
  )
    return { ...unavailable, error: '请确认当前草稿版本及发布影响。' };
  const merchant = await currentMerchantForWrite(merchantId, csrfToken);
  if (!merchant) return { ...unavailable, error: '登录或安全校验已失效，请重新登录。' };
  const [workerAvailable, publicApiAvailable] = await Promise.all([
    workerReady(),
    publicApiReady(),
  ]);
  if (!workerAvailable) {
    return { ...unavailable, error: 'AI 对话服务尚未就绪，请稍后再试。' };
  }
  if (!publicApiAvailable) {
    return { ...unavailable, error: '公开会话服务尚未就绪，请稍后再试。' };
  }
  const database = loadDatabaseConfig();
  if (!database.configured) return { ...unavailable, error: '数据库尚未配置。' };
  const revision = Number(revisionText);
  const now = new Date();
  const repository = new MySqlAssistantLifecycleRepository(database.config);
  try {
    const assistant = await repository.findManagementSnapshot(
      toMerchantId(merchantId),
      toAssistantId(assistantId),
    );
    if (
      !assistant ||
      assistant.draftRevision !== revision ||
      (!confirmAndPublish && !assistant.knowledgeConfirmed) ||
      assistant.status === 'paused'
    ) {
      return { ...unavailable, error: '草稿或资料确认状态已变化，请刷新后重新检查。' };
    }
    const governance = await repository.getPublicationGovernance({
      merchantUserId: toMerchantUserId(merchant.merchantUserId),
      merchantId: toMerchantId(merchantId),
      assistantId: toAssistantId(assistantId),
      now,
    });
    if (governance.draftRevision !== revision || !governance.canManage)
      return { ...unavailable, error: '草稿或管理权限已变化，请刷新核对。' };
    if (governance.issues.some((issue) => issue.severity === 'blocking'))
      return { ...unavailable, error: '存在业务事实冲突或失效资料，请先处理发布检查中的问题。' };
    if (governance.quality.state !== 'passed')
      return { ...unavailable, error: '请先成功试聊当前修订，并由商家核对判定回答合格后发布。' };
    // Consent covers both operations. Each repository transaction rechecks the
    // current member, assistant ownership and exact revision under its own lock.
    // If publish fails after confirmation, never report a published version/link.
    if (confirmAndPublish && !assistant.knowledgeConfirmed) {
      await repository.confirmDraftKnowledge({
        merchantUserId: toMerchantUserId(merchant.merchantUserId),
        merchantId: toMerchantId(merchantId),
        assistantId: toAssistantId(assistantId),
        expectedDraftRevision: revision,
        now,
      });
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
        requestHash: digest(
          JSON.stringify({
            merchantId,
            assistantId,
            revision,
            promptTemplateVersion: policy.promptTemplateVersion,
            retrievalPolicyVersion: policy.retrievalPolicyVersion,
            modelPolicyVersion: policy.modelPolicyVersion,
            ...(confirmAndPublish ? { confirmation: 'confirm-and-publish-v1' } : {}),
          }),
        ),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      },
      now,
    });
    for (const section of ['drafts', 'knowledge', 'preview', 'publish'])
      revalidatePath(`/${merchantId}/${section}/${assistantId}`);
    revalidatePath(`/${merchantId}`);
    revalidatePath(`/${merchantId}/drafts`);
    revalidatePath(`/${merchantId}/knowledge`);
    revalidatePath(`/${merchantId}/preview`);
    revalidatePath(`/${merchantId}/publish`);
    revalidatePath(`/${merchantId}/improvements`);
    revalidatePath('/[merchantId]/improvements/[improvementId]', 'page');
    // publish() has committed the active release (or recovered its idempotent
    // result). The assistant's slug is persisted at creation and is never
    // regenerated for a new release. A transient extra public read must not
    // erase a successfully published permanent link.
    const publicUrl = publicAssistantUrl(policy.consumerOrigin, assistant.publicSlug);
    return {
      error: publicUrl ? null : '版本已发布，但固定链接格式异常；请联系运营核对，勿重复发布。',
      published: true,
      publicUrl,
      releaseNo: release.releaseNo,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'PREVIEW_REQUIRED')
      return { ...unavailable, error: '当前修订尚未通过试聊判定，请返回效果试聊。' };
    if (error && typeof error === 'object' && 'code' in error && error.code === 'FACTS_BLOCKED')
      return { ...unavailable, error: '业务事实检查未通过，请修正冲突或失效资料后重新试聊。' };
    if (
      error instanceof AssistantPublishValidationError ||
      error instanceof AssistantRevisionConflictError ||
      error instanceof AssistantIdempotencyConflictError
    ) {
      return {
        ...unavailable,
        error: '本次尚未确认发布，草稿或授权状态已变化。请刷新核对；仅资料确认不代表已发布。',
      };
    }
    return { ...unavailable, error: '发布结果尚未确认，请刷新页面核对线上版本，勿连续重复提交。' };
  }
}
