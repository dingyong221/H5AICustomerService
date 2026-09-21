import type { Metadata } from 'next';

import { PageShell, StatusBadge } from '@h5cs/ui';

import { WorkBuddyAuthorizationStatePanel } from '../auth/workbuddy/authorization-state-panel';
import { buildWorkBuddyConnectionViewModel } from '../auth/workbuddy/connection-view-model';
import { loadTrustedWorkBuddyAuthorizationSnapshot } from '../auth/workbuddy/trusted-server-state';

export const metadata: Metadata = {
  description: '由可信服务端状态驱动的平台登录入口。',
  title: '登录后管理客服',
};

export default async function LoginPage() {
  const trustedServerSnapshot = await loadTrustedWorkBuddyAuthorizationSnapshot();
  const connection = buildWorkBuddyConnectionViewModel({
    applicationOrigin: process.env['MERCHANT_WEB_ORIGIN'],
    trustedServerSnapshot,
  });

  return (
    <PageShell
      aside={<StatusBadge tone={connection.tone}>{connection.label}</StatusBadge>}
      description={<p>登录只建立平台会话，不能替代身份绑定、商家选择或授权同意。</p>}
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
      title="登录后继续 WorkBuddy 授权"
    >
      <section className="login-gate">
        <div>
          <p className="panel__eyebrow">可信状态边界</p>
          <h2>只有服务端会话可以确认登录</h2>
          <p>
            页面不从URL、callback、环境变量中的状态字符串或前端缓存推断账号。当前没有账号状态后端路由时，流程会停在不可用状态。
          </p>
        </div>
      </section>
      <WorkBuddyAuthorizationStatePanel backHref="/" model={connection} />
    </PageShell>
  );
}
