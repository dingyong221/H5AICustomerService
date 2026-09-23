'use client';

import { useActionState } from 'react';

import { provisionMerchant } from './operator-actions';

export function ProvisionForm() {
  const [state, action, pending] = useActionState(provisionMerchant, {
    error: null,
    created: null,
  });
  return (
    <div className="ops-provision">
      <form action={action} className="ops-form">
        <label>
          商家名称
          <input
            maxLength={200}
            minLength={2}
            name="name"
            placeholder="例如：广州示例餐饮"
            required
          />
        </label>
        <button disabled={pending || state.created !== null} type="submit">
          {pending ? '正在创建…' : '创建商家并生成领取链接'}
        </button>
      </form>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.created ? (
        <div className="ops-created" role="status">
          <strong>{state.created.name} 已创建，等待商家领取</strong>
          <p>请将下列一次性链接通过受控渠道交给商家负责人。链接过期后需重新签发。</p>
          <output>{state.created.setupUrl}</output>
          <small>有效期至 {new Date(state.created.expiresAt).toLocaleString('zh-CN')}</small>
        </div>
      ) : null}
    </div>
  );
}
