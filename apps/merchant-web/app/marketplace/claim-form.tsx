'use client';
import { useActionState, useEffect, useRef } from 'react';
import { claimMarketplace } from '../account/merchant-actions';
import { type OfferTerms } from './offer-copy';

export function MarketplaceClaimForm({ offer }: { offer?: OfferTerms }) {
  const [state, action, pending] = useActionState(claimMarketplace, { error: null });
  const form = useRef<HTMLFormElement>(null);
  const submitted = useRef<FormData | null>(null);
  useEffect(() => {
    if (!state.error || !submitted.current) return;
    // React resets successful action submissions. Restore a rejected attempt only
    // in this mounted form; credentials never leave client memory through state.
    for (const name of ['merchantName', 'claimCode', 'phone', 'password']) {
      const input = form.current?.elements.namedItem(name);
      if (input instanceof HTMLInputElement)
        input.value = String(submitted.current.get(name) ?? '');
    }
    submitted.current = null;
  }, [state]);
  return (
    <form
      ref={form}
      action={action}
      onSubmit={(event) => {
        submitted.current = new FormData(event.currentTarget);
      }}
      className="merchant-account-form"
      data-usage="register.submit"
    >
      {offer ? (
        <label>
          商家名称
          <input
            name="merchantName"
            required
            maxLength={100}
            autoComplete="organization"
            placeholder="请输入商家或店铺名称"
          />
        </label>
      ) : null}
      {!offer ? (
        <label>
          本地合成领取码（10分钟有效）
          <input name="claimCode" required maxLength={43} autoComplete="off" />
        </label>
      ) : null}
      <label>
        手机号
        <input name="phone" required maxLength={20} autoComplete="username" inputMode="tel" />
      </label>
      <label>
        登录密码
        <input
          name="password"
          required
          type="password"
          minLength={12}
          maxLength={128}
          autoComplete="current-password"
          placeholder="至少12位；已有账号请输入原密码"
        />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? '正在开通，请稍候…' : '免费开通客来答'}
      </button>
    </form>
  );
}
