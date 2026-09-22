import type { Metadata } from 'next';

import { PageShell, StatusBadge } from '@h5cs/ui';

import { WorkBuddyAuthorizationFlow } from '../authorization-flow';

export const metadata: Metadata = {
  description: '查看单一商家的WorkBuddy Connector授权范围。',
  title: 'WorkBuddy 授权同意',
};

export default function WorkBuddyConsentPage() {
  return (
    <PageShell
      aside={<StatusBadge tone="info">服务端状态检查</StatusBadge>}
      description={<p>consent只对可信服务端确定的单一商家和当前Connector生效。</p>}
      eyebrow="OAuth Consent"
      title="确认 WorkBuddy Connector 授权"
    >
      <section className="login-gate">
        <div>
          <p className="panel__eyebrow">明确同意</p>
          <h2>登录和绑定都不等于授权</h2>
          <p>
            页面必须收到服务端确认的单一商家、当前事务与 scope 后才能提交
            consent；同意与拒绝都要求同源 Cookie 和显式 CSRF。
          </p>
        </div>
      </section>
      <WorkBuddyAuthorizationFlow
        apiBaseUrl={process.env['NEXT_PUBLIC_MERCHANT_API_BASE_URL']}
        backHref="/auth/workbuddy/bind"
      />
    </PageShell>
  );
}
