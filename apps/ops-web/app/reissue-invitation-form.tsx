'use client';

import { useActionState } from 'react';

import { reissueMerchantInvitation } from './operator-actions';
import { SetupLinkResult } from './setup-link-result';

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
        <button disabled={pending || state.created !== null} type="submit">
          {pending ? '正在重新签发…' : '重新签发领取链接'}
        </button>
      </form>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.created ? (
        <SetupLinkResult
          expiresAt={state.created.expiresAt}
          name={state.created.name}
          reissued
          setupUrl={state.created.setupUrl}
        />
      ) : null}
    </div>
  );
}
