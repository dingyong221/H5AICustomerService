'use client';

import { useActionState } from 'react';

import { reissueMerchantInvitation } from './operator-actions';

export function ReissueInvitationForm({ merchantId }: { merchantId: string }) {
  const [state, action, pending] = useActionState(reissueMerchantInvitation, {
    error: null,
    created: null,
  });
  return (
    <div className="ops-reissue">
      <form action={action} className="ops-form">
        <input name="merchantId" type="hidden" value={merchantId} />
        <label>
          <input name="confirm" required type="checkbox" value="invalidate_previous" />
          我确认旧领取链接将立即失效
        </label>
        <button disabled={pending} type="submit">
          {pending ? '正在重新签发…' : '重新签发领取链接'}
        </button>
      </form>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.created ? (
        <div className="ops-created" role="status">
          <strong>{state.created.name} 的新领取链接已生成</strong>
          <p>仅通过受控渠道交给商家负责人；本页离开后不再显示明文链接。</p>
          <output>{state.created.setupUrl}</output>
          <small>有效期至 {new Date(state.created.expiresAt).toLocaleString('zh-CN')}</small>
        </div>
      ) : null}
    </div>
  );
}
