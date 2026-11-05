'use client';
import { useActionState, useState } from 'react';
import { claimMarketplace } from '../account/merchant-actions';

export function MarketplaceClaimForm({ offer }: { offer?: { days: number; modelCalls: number } }) {
  const [state, action, pending] = useActionState(claimMarketplace, { error: null });
  const [merchantName, setMerchantName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  return (
    <form action={action} className="merchant-account-form">
      {offer ? (
        <label>
          商家名称
          <input
            name="merchantName"
            required
            maxLength={100}
            autoComplete="organization"
            placeholder="例如：青禾家居"
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
        密码（已有账号须原密码）
        <input
          name="password"
          required
          type="password"
          minLength={12}
          maxLength={128}
          autoComplete="current-password"
          placeholder="至少12个字符，请妥善保存"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <label className="merchant-claim-consent">
        <input name="reuseExisting" type="checkbox" />
        <span>
          已有商家时，我同意复用原商家和客服，并适用本次免费服务期限与额度；原链接保持不变
        </span>
      </label>
      <p>
        新用户用此手机号和密码注册，已有账号必须输入原密码。手机号仅用于登录，当前不进行短信验证；不会凭相同手机号自动关联外部平台账号。
      </p>
      <label className="merchant-claim-consent">
        <input name="acceptOffer" type="checkbox" required />
        <span>
          {offer
            ? `我已了解0元领取后首次开通可使用${offer.days}天，包含${offer.modelCalls}次AI调用尝试；重复领取不重置期限和额度，不会自动扣费。`
            : '我已了解本地合成测试的期限与额度。'}
        </span>
      </label>
      <p>
        AI调用包含消费者问答、试聊、资料撰写、知识整理及改善复测；失败或超时的尝试也可能计入。开通后仍需核对资料、试聊并发布，客户才可咨询。
      </p>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? '正在开通，请稍候…' : '0元领取并进入我的后台'}
      </button>
    </form>
  );
}
