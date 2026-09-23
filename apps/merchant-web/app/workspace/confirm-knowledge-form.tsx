'use client';

import { useActionState } from 'react';

import { confirmKnowledgeAction } from './knowledge-actions';

export function ConfirmKnowledgeForm({
  merchantId,
  assistantId,
  draftRevision,
  alreadyConfirmed,
}: {
  merchantId: string;
  assistantId: string;
  draftRevision: number;
  alreadyConfirmed: boolean;
}) {
  const [state, action, pending] = useActionState(confirmKnowledgeAction, {
    error: null,
    confirmed: false,
  });
  const confirmed = alreadyConfirmed || state.confirmed;
  return (
    <form action={action} className="assistant-confirm-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="assistantId" type="hidden" value={assistantId} />
      <input name="draftRevision" type="hidden" value={draftRevision} />
      <label>
        <input disabled={confirmed} name="merchantConfirmed" required type="checkbox" value="yes" />
        我已逐项核对以上资料，确认其真实、有效，并同意将其作为客服回答的业务依据。
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {confirmed ? <p role="status">当前草稿资料已确认；正式发布仍需完成对话服务与发布检查。</p> : null}
      <button disabled={confirmed || pending} type="submit">
        {pending ? '正在确认…' : '确认当前草稿资料'}
      </button>
    </form>
  );
}
