import type { Metadata } from 'next';

import { PageShell, StatusBadge } from '@h5cs/ui';

import { WorkBuddyAuthorizationStatePanel } from '../authorization-state-panel';
import { buildWorkBuddyConnectionViewModel } from '../connection-view-model';
import { loadTrustedWorkBuddyAuthorizationSnapshot } from '../trusted-server-state';

export const metadata: Metadata = {
  description: '查看单一商家的WorkBuddy Connector授权范围。',
  title: 'WorkBuddy 授权同意',
};

export default async function WorkBuddyConsentPage() {
  const trustedServerSnapshot = await loadTrustedWorkBuddyAuthorizationSnapshot();
  const connection = buildWorkBuddyConnectionViewModel({
    applicationOrigin: process.env['MERCHANT_WEB_ORIGIN'],
    trustedServerSnapshot,
  });

  return (
    <PageShell
      aside={<StatusBadge tone={connection.tone}>{connection.label}</StatusBadge>}
      description={<p>consent只对可信服务端确定的单一商家和当前Connector生效。</p>}
      eyebrow="OAuth Consent"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>{connection.label}</strong>
            <span>{connection.description}</span>
          </div>
        </div>
      }
      title="确认 WorkBuddy Connector 授权"
    >
      <section className="login-gate">
        <div>
          <p className="panel__eyebrow">明确同意</p>
          <h2>登录和绑定都不等于授权</h2>
          <p>
            页面必须收到服务端确认的Connector、单一商家与scope后才能显示可提交consent。当前没有提交路由时，同意与拒绝都保持禁用。
          </p>
        </div>
      </section>
      <WorkBuddyAuthorizationStatePanel backHref="/auth/workbuddy/bind" model={connection} />
    </PageShell>
  );
}
