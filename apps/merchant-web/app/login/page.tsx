import type { Metadata } from 'next';
import Link from 'next/link';

import { Button, PageShell, StatusBadge } from '@h5cs/ui';

import { buildWorkBuddyConnectionViewModel } from '../auth/workbuddy/connection-view-model';

export const metadata: Metadata = {
  description: '登录后进入已有 AI 客服管理后台。',
  title: '登录后管理客服',
};

function configuredAllowedOrigins(): readonly string[] {
  return (process.env['WORKBUDDY_AUTHORIZATION_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export default function LoginPage() {
  const applicationOrigin = process.env['MERCHANT_WEB_ORIGIN'];
  const serverAuthorizationEntry = process.env['WORKBUDDY_AUTHORIZATION_ENTRY'];
  const connection = buildWorkBuddyConnectionViewModel({
    allowedAuthorizationOrigins: configuredAllowedOrigins(),
    ...(applicationOrigin === undefined ? {} : { applicationOrigin }),
    ...(serverAuthorizationEntry === undefined ? {} : { serverAuthorizationEntry }),
  });

  return (
    <PageShell
      aside={<StatusBadge tone={connection.tone}>{connection.label}</StatusBadge>}
      description={<p>管理地址只负责定位页面，不能替代身份认证或商家权限校验。</p>}
      eyebrow="Authenticated Console"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>{connection.label}</strong>
            <span>{connection.description}</span>
          </div>
        </div>
      }
      title="登录后继续管理已有客服"
    >
      <section className="login-gate">
        <div>
          <p className="panel__eyebrow">访问控制</p>
          <h2>管理页面必须校验登录与商家归属</h2>
          <p>
            即使入口由 WorkBuddy 返回，也必须先由服务端确认连接与登录；URL
            参数不能替代账号、商家和客服权限校验。
          </p>
        </div>
        <div className="login-gate__actions">
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
          <Link className="quiet-link" href="/auth/workbuddy/bind">
            前往 HTTPS 安全绑定页
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
