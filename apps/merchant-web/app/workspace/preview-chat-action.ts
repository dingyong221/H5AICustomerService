'use server';

import {
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlKnowledgeMaterialRepository,
  KnowledgeMaterialAccessError,
} from '@h5cs/database';
import {
  AssistantRevisionConflictError,
  toAssistantId,
  toMerchantId,
  toMerchantUserId,
} from '@h5cs/domain';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { currentMerchantForWrite } from '../account/merchant-actions';
import { requestWorkerPreview, WorkerPreviewRateLimitError } from './worker-preview';
import { MarketplaceModelError } from './model-service-error';
import { previewEvidence, type PreviewEvidence } from './preview-evidence';

export type PreviewChatState = Readonly<{
  answer: string | null;
  error: string | null;
  revision: number | null;
  evidence?: PreviewEvidence;
  checkId?: string | null;
}>;

export async function previewChatAction(
  _previous: PreviewChatState,
  formData: FormData,
): Promise<PreviewChatState> {
  const failed = (error: string): PreviewChatState => ({ answer: null, error, revision: null });
  const origin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!origin || (await headers()).get('origin') !== origin) return failed('请求来源校验失败。');
  const merchantId = formData.get('merchantId');
  const assistantId = formData.get('assistantId');
  const revision = formData.get('draftRevision');
  const csrfToken = formData.get('csrfToken');
  const rawQuestion = formData.get('question');
  if (
    typeof merchantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(merchantId) ||
    typeof assistantId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(assistantId) ||
    typeof revision !== 'string' ||
    !/^[1-9][0-9]{0,9}$/u.test(revision) ||
    typeof csrfToken !== 'string' ||
    typeof rawQuestion !== 'string' ||
    rawQuestion.trim().length < 1 ||
    rawQuestion.length > 2_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(rawQuestion)
  ) {
    return failed('请输入 1 至 2000 字的测试问题。');
  }
  const session = await currentMerchantForWrite(merchantId, csrfToken);
  if (!session) return failed('登录已失效或无权试聊此商家。');
  const database = loadDatabaseConfig();
  if (!database.configured) return failed('数据库暂不可用。');
  try {
    // A valid merchant login alone is insufficient for a model-invoking write.
    await new MySqlKnowledgeMaterialRepository(database.config).assertEditable(
      merchantId,
      assistantId,
      session.merchantUserId,
    );
    const snapshot = await new MySqlAssistantLifecycleRepository(
      database.config,
    ).findManagementSnapshot(toMerchantId(merchantId), toAssistantId(assistantId));
    if (!snapshot || snapshot.draftRevision !== Number(revision) || snapshot.status === 'paused') {
      return failed('草稿已变化或不可试聊，请刷新页面。');
    }
    // Capture the raw governance receipt before the model call. Browser fields
    // and the filtered quality view cannot supply this concurrency precondition.
    const expectedPreviousPreviewId = snapshot.previousPreviewCheckId;
    const answer = await requestWorkerPreview({
      merchantId,
      assistantName: snapshot.displayName,
      draft: snapshot.draft,
      question: rawQuestion.trim(),
    });
    let checkId: string;
    try {
      const recorded = await new MySqlAssistantLifecycleRepository(
        database.config,
      ).savePreviewCheck({
        merchantUserId: toMerchantUserId(session.merchantUserId),
        merchantId: toMerchantId(merchantId),
        assistantId: toAssistantId(assistantId),
        expectedDraftRevision: snapshot.draftRevision,
        expectedPreviousPreviewId,
        question: rawQuestion.trim(),
        answer,
        now: new Date(),
      });
      checkId = recorded.checkId;
    } catch (error) {
      return {
        answer,
        revision: snapshot.draftRevision,
        checkId: null,
        evidence: previewEvidence(snapshot.draft),
        error:
          error instanceof AssistantRevisionConflictError
            ? '草稿或试聊记录已更新，这次迟到回答仅供查看，不能用于发布判定。请刷新核对当前记录。'
            : '回答已生成，但未能保存本修订的试聊记录，不能用于发布判定。请先刷新检查草稿修订，勿直接发布。',
      };
    }
    revalidatePath(`/${merchantId}`);
    revalidatePath(`/${merchantId}/preview/${assistantId}`);
    revalidatePath(`/${merchantId}/publish/${assistantId}`);
    return {
      answer,
      error: null,
      revision: snapshot.draftRevision,
      evidence: previewEvidence(snapshot.draft),
      checkId,
    };
  } catch (error) {
    if (error instanceof MarketplaceModelError) return failed(error.message);
    if (error instanceof KnowledgeMaterialAccessError)
      return failed('登录已失效或无权试聊此客服。');
    if (error instanceof WorkerPreviewRateLimitError)
      return failed('试聊请求较频繁，请一分钟后重试。');
    return failed('试聊服务暂不可用，请稍后重试。');
  }
}
