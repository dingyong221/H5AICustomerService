'use client';

import { useActionState } from 'react';
import Link from 'next/link';

import type { AssistantDraftConfig } from '@h5cs/domain';

import { saveAssistantDraftAction } from './knowledge-actions';

export function EditDraftForm({
  merchantId,
  assistantId,
  draftRevision,
  draft,
  returnPath,
}: {
  merchantId: string;
  assistantId: string;
  draftRevision: number;
  draft: AssistantDraftConfig;
  returnPath?: string;
}) {
  const [state, action, pending] = useActionState(saveAssistantDraftAction, {
    error: null,
    saved: false,
  });
  return (
    <form action={action} className="assistant-edit-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="assistantId" type="hidden" value={assistantId} />
      <input name="draftRevision" type="hidden" value={draftRevision} />
      <label>
        细分行业
        <input defaultValue={draft.industry} maxLength={128} name="industry" required />
      </label>
      <label>
        业务范围
        <textarea
          defaultValue={draft.businessScope}
          maxLength={2000}
          name="businessScope"
          required
          rows={3}
        />
      </label>
      <label>
        商品或服务资料
        <textarea
          defaultValue={draft.materialsSummary}
          maxLength={4000}
          name="materialsSummary"
          required
          rows={4}
        />
      </label>
      <label>
        价格与条件
        <textarea
          defaultValue={draft.pricingSummary}
          maxLength={4000}
          name="pricingSummary"
          required
          rows={2}
        />
      </label>
      <label>
        优惠与售卖策略
        <textarea
          defaultValue={draft.promotionSummary}
          maxLength={4000}
          name="promotionSummary"
          required
          rows={2}
        />
      </label>
      <label>
        欢迎语
        <input defaultValue={draft.welcomeMessage} maxLength={500} name="welcomeMessage" required />
      </label>
      <label>
        资料不足时的回复
        <input
          defaultValue={draft.insufficientInfoMessage}
          maxLength={500}
          name="insufficientInfoMessage"
          required
        />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.saved ? (
        <p role="status">
          草稿已保存，原有资料确认已失效。请
          <Link href={returnPath ?? `/${merchantId}/drafts/${assistantId}`}>
            重新打开并核对新修订
          </Link>
          。
        </p>
      ) : null}
      <button disabled={pending || state.saved} type="submit">
        {pending ? '正在保存…' : '保存草稿修订'}
      </button>
    </form>
  );
}
