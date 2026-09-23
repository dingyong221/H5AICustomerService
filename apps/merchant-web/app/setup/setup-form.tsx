'use client';

import { useActionState, useEffect, useState } from 'react';

import { claimMerchant } from '../account/merchant-actions';

export function SetupForm() {
  const [setupToken, setSetupToken] = useState('');
  const [state, action, pending] = useActionState(claimMerchant, { error: null });

  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (/^[A-Za-z0-9_-]{43}$/u.test(token)) {
      window.history.replaceState(null, '', window.location.pathname);
      queueMicrotask(() => setSetupToken(token));
    }
  }, []);

  return (
    <form action={action} className="merchant-account-form">
      <input name="setupToken" type="hidden" value={setupToken} />
      <p>领取链接绑定一位商家负责人；已有平台账号可用原手机号和密码领取。</p>
      <label>
        负责人手机号
        <input autoComplete="tel" inputMode="tel" name="phone" placeholder="中国大陆手机号" required />
      </label>
      <label>
        {`平台登录密码（至少 12 位）`}
        <input autoComplete="new-password" minLength={12} name="password" required type="password" />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {!setupToken ? <p role="alert">领取链接无效或已从地址栏移除，请向平台运营重新获取。</p> : null}
      <button disabled={pending || !setupToken} type="submit">
        {pending ? '正在领取…' : '领取商家后台'}
      </button>
    </form>
  );
}
