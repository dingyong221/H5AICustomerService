'use client';

import { useActionState } from 'react';

import { createAssistantDraft } from './workspace-actions';

export function CreateAssistantForm({
  merchantId,
  idempotencyKey,
}: {
  merchantId: string;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(createAssistantDraft, {
    error: null,
    created: null,
  });
  return (
    <form action={action} className="assistant-create-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <label>
        客服名称
        <input maxLength={200} name="displayName" required />
      </label>
      <label>
        细分行业
        <input maxLength={128} name="industry" required />
      </label>
      <label>
        业务范围
        <textarea maxLength={2000} name="businessScope" required rows={3} />
      </label>
      <label>
        商品或服务资料
        <textarea maxLength={4000} name="materialsSummary" required rows={4} />
      </label>
      <label>
        价格与条件
        <textarea
          maxLength={4000}
          name="pricingSummary"
          placeholder="没有公开价格时可填写：价格需联系商家确认"
          required
          rows={2}
        />
      </label>
      <label>
        优惠与售卖策略
        <textarea
          maxLength={4000}
          name="promotionSummary"
          placeholder="无优惠时可填写：目前无优惠活动"
          required
          rows={2}
        />
      </label>
      <label>
        欢迎语
        <input maxLength={500} name="welcomeMessage" required />
      </label>
      <label>
        资料不足时的回复
        <input maxLength={500} name="insufficientInfoMessage" required />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.created ? (
        <p role="status">已创建客服草稿「{state.created.displayName}」。请在下方列表查看。</p>
      ) : null}
      <button disabled={pending || state.created !== null} type="submit">
        {pending ? '正在保存…' : '创建客服草稿'}
      </button>
    </form>
  );
}
