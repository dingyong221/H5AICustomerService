'use client';

import { useActionState } from 'react';

import { setMerchantPaused } from './merchant-status-actions';

export function MerchantStatusForm({
  merchantId,
  paused,
}: {
  merchantId: string;
  paused: boolean;
}) {
  const [state, action, pending] = useActionState(setMerchantPaused, {
    error: null,
    done: null,
  });
  return (
    <form action={action} className="ops-form ops-merchant-status-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="operation" type="hidden" value={paused ? 'pause' : 'resume'} />
      <p>
        {paused
          ? '暂停将阻断该商家的公开客服、已有咨询及管理访问；资料和固定链接不会删除。'
          : '恢复后，仍处于已发布状态的客服可沿用原消费者链接。请先确认暂停原因已解除。'}
      </p>
      <label>
        操作原因（写入审计）
        <textarea maxLength={512} minLength={5} name="reason" required rows={2} />
      </label>
      <label className="ops-merchant-status-confirm">
        <input name="confirmed" required type="checkbox" value="yes" />
        我已核对商家编号和操作影响
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.done ? <p role="status">商家状态已更新；请刷新列表核对。</p> : null}
      <button disabled={pending || state.done !== null} type="submit">
        {pending ? '正在提交…' : paused ? '确认暂停商家' : '确认恢复商家'}
      </button>
    </form>
  );
}
