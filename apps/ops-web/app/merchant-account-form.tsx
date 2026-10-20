'use client';
import { useActionState } from 'react';
import Link from 'next/link';
import type { MerchantManagedAccount } from '@h5cs/database';
import { resetMerchantPassword } from './merchant-account-actions';

export function MerchantAccountForm({
  merchantId,
  account,
}: {
  merchantId: string;
  account: MerchantManagedAccount;
}) {
  const [state, action, pending] = useActionState(resetMerchantPassword, {
    error: null,
    done: false,
  });
  return (
    <article className="ops-status-panel">
      <p>
        登录账号：<code>{account.account}</code>（原手机号仍可登录）
      </p>
      <p>
        角色：{account.role === 'owner' ? '负责人' : account.role} · 账号状态：
        {account.status === 'active' ? '已启用' : '已停用'}
      </p>
      <p>此账号关联 {account.relatedMerchants.length} 个商家，请同时核对商家名称与 ID：</p>
      <ul>
        {account.relatedMerchants.map((item) => (
          <li key={item.id}>
            <Link href={`/merchants/${item.id}`}>{item.name}</Link>（<code>{item.id}</code>）
          </li>
        ))}
      </ul>
      <p className="ops-muted">
        密码不保存为明文，不能查看原密码。重置将影响此账号管理的全部商家，并使该账号所有旧会话退出；不改商家状态或消费者客服。
      </p>
      {state.done ? (
        <p role="status">
          密码已重置，旧登录会话已失效。请通过安全渠道将新密码告知商家；页面不回显密码。
        </p>
      ) : account.status === 'active' ? (
        <details>
          <summary>重置此账号密码</summary>
          <form action={action} className="ops-form">
            <input type="hidden" name="merchantId" value={merchantId} />
            <input type="hidden" name="userId" value={account.userId} />
            <input type="hidden" name="version" value={account.version} />
            <input
              type="hidden"
              name="affectedMerchantIds"
              value={JSON.stringify(account.relatedMerchants.map((item) => item.id))}
            />
            <label>
              新密码
              <input
                autoComplete="new-password"
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            <label>
              确认新密码
              <input
                autoComplete="new-password"
                name="passwordConfirm"
                type="password"
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            <label>
              重置原因（写入审计）
              <select name="reason" required defaultValue="">
                <option value="" disabled>
                  请选择重置原因
                </option>
                <option value="忘记密码">忘记密码</option>
                <option value="商家申请">商家申请</option>
                <option value="安全处理">安全处理</option>
                <option value="其他人工核对">其他人工核对</option>
              </select>
            </label>
            <label>
              当前运营账号密码
              <input
                autoComplete="current-password"
                name="operatorPassword"
                type="password"
                required
                maxLength={1024}
              />
            </label>
            <label>
              <input type="checkbox" name="confirmed" value="yes" required />
              我已核对账号与全部关联商家，确认退出其所有旧登录会话
            </label>
            {state.error ? <p role="alert">{state.error}</p> : null}
            <button disabled={pending} type="submit">
              {pending ? '正在重置…' : '确认重置商家密码'}
            </button>
          </form>
        </details>
      ) : null}
    </article>
  );
}
