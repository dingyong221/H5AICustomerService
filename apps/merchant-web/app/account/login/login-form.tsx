'use client';

import { useActionState } from 'react';

import { loginMerchant } from '../merchant-actions';

export function MerchantLoginForm({ merchantId }: { merchantId?: string }) {
  const [state, action, pending] = useActionState(loginMerchant, { error: null });
  return (
    <form action={action} className="merchant-account-form">
      <input name="merchantId" type="hidden" value={merchantId ?? ''} />
      <label>
        手机号
        <input autoComplete="username" inputMode="tel" name="phone" required />
      </label>
      <label>
        密码
        <input autoComplete="current-password" name="password" required type="password" />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button disabled={pending} type="submit">
        {pending ? '正在登录…' : '登录商家后台'}
      </button>
    </form>
  );
}
