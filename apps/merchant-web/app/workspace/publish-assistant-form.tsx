'use client';

import { useActionState } from 'react';

import { publishAssistantAction } from './publish-actions';

export function PublishAssistantForm({
  merchantId,
  assistantId,
  draftRevision,
  csrfToken,
  idempotencyKey,
  ready,
  reason,
}: {
  merchantId: string;
  assistantId: string;
  draftRevision: number;
  csrfToken: string;
  idempotencyKey: string;
  ready: boolean;
  reason: string | null;
}) {
  const [state, action, pending] = useActionState(publishAssistantAction, {
    error: null,
    published: false,
    publicUrl: null,
    releaseNo: null,
  });
  const canPublish = ready && csrfToken.length > 0;
  return (
    <form action={action} className="assistant-confirm-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="assistantId" type="hidden" value={assistantId} />
      <input name="draftRevision" type="hidden" value={draftRevision} />
      <input name="csrfToken" type="hidden" value={csrfToken} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <p>发布会让新咨询使用草稿修订 {draftRevision} 的已确认资料；现有会话继续使用建立时的版本。</p>
      <label>
        <input
          disabled={!canPublish || state.published}
          name="publishConfirmed"
          required
          type="checkbox"
          value="yes"
        />
        我确认发布当前修订，并向消费者开放 AI 客服。
      </label>
      {!ready && reason ? <p role="status">{reason}</p> : null}
      {ready && !csrfToken ? <p role="status">安全校验信息缺失，请重新登录。</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.publicUrl ? (
        <p role="status">
          Release #{state.releaseNo} 已发布。消费者链接：
          <a href={state.publicUrl}>{state.publicUrl}</a>
        </p>
      ) : null}
      <button disabled={!canPublish || state.published || pending} type="submit">
        {pending ? '正在发布…' : '确认发布 AI 客服'}
      </button>
    </form>
  );
}
