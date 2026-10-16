'use client';

import { useActionState } from 'react';

import { previewChatAction } from './preview-chat-action';

export function PreviewChatForm({
  merchantId,
  assistantId,
  draftRevision,
  csrfToken,
  available,
}: {
  merchantId: string;
  assistantId: string;
  draftRevision: number;
  csrfToken: string;
  available: boolean;
}) {
  const [state, action, pending] = useActionState(previewChatAction, {
    answer: null,
    error: null,
    revision: null,
  });
  return (
    <form action={action} className="assistant-preview-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="assistantId" type="hidden" value={assistantId} />
      <input name="draftRevision" type="hidden" value={draftRevision} />
      <input name="csrfToken" type="hidden" value={csrfToken} />
      <label>
        试聊问题
        <textarea
          maxLength={2_000}
          name="question"
          placeholder="例如：你们提供哪些服务？价格怎么确定？"
          required
          rows={3}
        />
      </label>
      <p>仅使用测试资料。试聊会把当前草稿资料和问题发送至阿里云千问；试聊不会发布客服。</p>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.answer && state.revision === draftRevision ? (
        <div aria-live="polite" className="assistant-preview-answer">
          <strong>AI 试聊回答</strong>
          <p>{state.answer}</p>
        </div>
      ) : null}
      <button disabled={!available || pending} type="submit">
        {pending ? '正在试聊…' : '发送测试问题'}
      </button>
      {!available ? <p role="status">AI 对话服务尚未就绪，暂不能试聊。</p> : null}
    </form>
  );
}
