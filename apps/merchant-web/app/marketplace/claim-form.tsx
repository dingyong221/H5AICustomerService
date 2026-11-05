'use client';
import { useActionState, useState } from 'react';
import { claimMarketplace } from '../account/merchant-actions';
import { type OfferTerms } from './offer-copy';

export function MarketplaceClaimForm({ offer }: { offer?: OfferTerms }) {
  const [state, action, pending] = useActionState(claimMarketplace, { error: null });
  const [merchantName, setMerchantName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form action={action} className="merchant-account-form" data-usage="register.submit">
      {offer ? (
        <label>
          商家名称
          <input
            name="merchantName"
            required
            maxLength={100}
            autoComplete="organization"
            placeholder="请输入商家或店铺名称"
            value={merchantName}
            onChange={(event) => setMerchantName(event.target.value)}
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
        <input
          name="phone"
          required
          maxLength={20}
          autoComplete="username"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
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
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? '正在开通，请稍候…' : '免费开通客来答'}
      </button>
    </form>
  );
}
