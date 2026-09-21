import type { Metadata } from 'next';
import Link from 'next/link';

import { Button, PageShell, StatusBadge } from '@h5cs/ui';

import { buildWorkBuddyConnectionViewModel } from '../connection-view-model';

export const metadata: Metadata = {
  description: '在本站 HTTPS 页面安全绑定 WorkBuddy 身份。',
  title: 'WorkBuddy 安全绑定',
};

type SearchParameters = Record<string, string | readonly string[] | undefined>;

function configuredAllowedOrigins(): readonly string[] {
  return (process.env['WORKBUDDY_AUTHORIZATION_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export default async function WorkBuddyBindingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParameters>;
}) {
  const callbackParameters = await searchParams;
  const applicationOrigin = process.env['MERCHANT_WEB_ORIGIN'];
  const serverAuthorizationEntry = process.env['WORKBUDDY_AUTHORIZATION_ENTRY'];
  const connection = buildWorkBuddyConnectionViewModel({
    allowedAuthorizationOrigins: configuredAllowedOrigins(),
    callbackParameters,
    ...(applicationOrigin === undefined ? {} : { applicationOrigin }),
    ...(serverAuthorizationEntry === undefined ? {} : { serverAuthorizationEntry }),
  });

  return (
    <PageShell
      aside={<StatusBadge tone={connection.tone}>{connection.label}</StatusBadge>}
      description={<p>授权操作仅在本站 HTTPS 页面完成，并由服务端创建可撤销的登录会话。</p>}
      eyebrow="Secure Binding"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>{connection.label}</strong>
            <span>{connection.description}</span>
          </div>
        </div>
      }
      title="安全绑定 WorkBuddy"
    >
      <section className="auth-placeholder">
        <span aria-hidden="true" className="auth-placeholder__number">
          01
        </span>
        <div>
          <h2>确认正式 HTTPS 地址</h2>
          <p>只接受服务端提供且经过同源或允许域校验的 HTTPS 授权入口。</p>
        </div>
        <span aria-hidden="true" className="auth-placeholder__number">
          02
        </span>
        <div>
          <h2>由服务端完成身份交换</h2>
          <p>页面只接收受限的 code、state 或 error 回调，不展示参数值，也不据此认定已连接。</p>
        </div>
        <span aria-hidden="true" className="auth-placeholder__number">
          03
        </span>
        <div>
          <h2>登录后继续操作</h2>
          <p>不会要求输入令牌、密码、验证码或 open_id，也不会把令牌写入 localStorage。</p>
        </div>
        <div className="auth-placeholder__actions">
          {connection.authorizationHref ? (
            <a
              className="secure-auth-link"
              href={connection.authorizationHref}
              referrerPolicy="no-referrer"
              rel="noreferrer"
            >
              {connection.actionLabel}
            </a>
          ) : connection.state === 'connected' ? (
            <Link className="secure-auth-link" href="/">
              返回工作台
            </Link>
          ) : (
            <Button disabled>{connection.actionLabel}</Button>
          )}
          <Link className="quiet-link" href="/">
            返回工作台
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
