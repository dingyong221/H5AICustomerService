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
          {state.evidence ? (
            <details className="preview-evidence">
              <summary>核对本次试聊依据 · 草稿修订 {state.revision}</summary>
              <p>
                下方是本次实际发送的已保存草稿资料。当前采用完整确认事实，不是向量检索结果或模型逐句引用；请自行检查回答是否有依据。来源标记属于商家核对的稿件，不保证每个附件的所有内容都已纳入。
              </p>
              {state.evidence.map((item) => (
                <details key={item.label}>
                  <summary>{item.label}</summary>
                  <pre>{item.text}</pre>
                </details>
              ))}
            </details>
          ) : null}
        </div>
      ) : null}
      {state.answer && state.revision !== draftRevision ? (
        <p role="status">草稿已变化，旧修订的试聊回答已隐藏，请用当前资料重新试聊。</p>
      ) : null}
      <button disabled={!available || pending} type="submit">
        {pending ? '正在试聊…' : '发送测试问题'}
      </button>
      {!available ? <p role="status">AI 对话服务尚未就绪，暂不能试聊。</p> : null}
    </form>
  );
}
