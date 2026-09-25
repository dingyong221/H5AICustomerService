'use client';

import { useActionState } from 'react';

import { provisionMerchant } from './operator-actions';
import { SetupLinkResult } from './setup-link-result';

export function ProvisionForm({ idempotencyKey }: { idempotencyKey: string }) {
  const [state, action, pending] = useActionState(provisionMerchant, {
    error: null,
    created: null,
  });
  return (
    <div className="ops-provision">
      <form action={action} className="ops-form">
        <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
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
        <SetupLinkResult
          expiresAt={state.created.expiresAt}
          name={state.created.name}
          setupUrl={state.created.setupUrl}
        />
      ) : null}
    </div>
  );
}
