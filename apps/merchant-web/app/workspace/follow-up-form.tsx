'use client';

import { useActionState } from 'react';

import type { FollowUpStatus } from '@h5cs/database';

import { updateFollowUpStatus } from './follow-up-actions';

export function FollowUpForm({
  merchantId,
  sessionId,
  csrfToken,
  currentStatus,
}: {
  merchantId: string;
  sessionId: string;
  csrfToken: string;
  currentStatus: FollowUpStatus;
}) {
  const [state, action, pending] = useActionState(updateFollowUpStatus, {
    error: null,
    saved: false,
  });
  return (
    <form action={action} className="merchant-follow-up-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="sessionId" type="hidden" value={sessionId} />
      <input name="csrfToken" type="hidden" value={csrfToken} />
      <label htmlFor="follow-up-status">人工跟进状态</label>
      <select defaultValue={currentStatus} id="follow-up-status" name="status">
        <option value="pending">待处理</option>
        <option value="in_progress">处理中</option>
        <option value="resolved">已处理</option>
      </select>
      <button disabled={pending || !csrfToken} type="submit">
        {pending ? '正在保存…' : '保存跟进状态'}
      </button>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.saved ? <p role="status">已保存；咨询原始消息未修改。</p> : null}
    </form>
  );
}
