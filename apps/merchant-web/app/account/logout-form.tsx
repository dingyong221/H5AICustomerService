'use client';

import { useActionState } from 'react';

import { Button } from '@h5cs/ui';

import { logoutMerchant } from './merchant-actions';

export function MerchantLogoutForm({
  merchantId,
  csrfToken,
}: {
  merchantId: string;
  csrfToken: string;
}) {
  const [state, action, pending] = useActionState(logoutMerchant, { error: null });
  return (
    <form action={action} data-usage="logout">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="csrfToken" type="hidden" value={csrfToken} />
      {state.error ? <p role="alert">{state.error}</p> : null}
      <Button busy={pending} disabled={!csrfToken} size="small" type="submit" variant="secondary">
        退出登录
      </Button>
    </form>
  );
}
