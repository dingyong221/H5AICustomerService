'use client';
import { useActionState, useState } from 'react';
import { createInvitation } from './actions';
export function InviteForm({
  merchantId,
  csrfToken,
  initialUrl,
}: {
  merchantId: string;
  csrfToken: string;
  initialUrl: string | null;
}) {
  const [state, action, pending] = useActionState(createInvitation, {
    error: null,
    url: initialUrl,
  });
  const [notice, setNotice] = useState('');
  return (
    <>
      <form action={action} className="merchant-account-form" data-usage="invite.create">
        <input type="hidden" name="merchantId" value={merchantId} />
        <input type="hidden" name="csrfToken" value={csrfToken} />
        {!state.url ? (
          <button data-usage="invite.create" disabled={pending}>
            {pending ? '正在准备…' : '生成我的邀请入口'}
          </button>
        ) : null}
        {state.error ? <p role="alert">{state.error}</p> : null}
      </form>
      {state.url ? (
        <>
          <label>
            邀请链接
            <input
              aria-label="邀请链接"
              readOnly
              value={state.url}
              style={{ width: '100%', padding: 12 }}
            />
          </label>
          <p>
            <button
              type="button"
              data-usage="invite.copy"
              onClick={() => {
                if (!navigator.clipboard?.writeText) {
                  setNotice('请选中上方链接手动复制。');
                  return;
                }
                void navigator.clipboard
                  .writeText(state.url!)
                  .then(() => setNotice('邀请链接已复制。'))
                  .catch(() => setNotice('复制失败，请选中上方链接手动复制。'));
              }}
            >
              复制邀请链接
            </button>{' '}
            <a data-usage="invite.qr" href={`/${merchantId}/invite/qr`} download>
              下载邀请商家二维码
            </a>
          </p>
          <p role="status">{notice}</p>
        </>
      ) : null}
    </>
  );
}
