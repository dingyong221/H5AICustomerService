import type { Metadata } from 'next';

import { PageShell, StatusBadge } from '@h5cs/ui';

import { WorkBuddyAuthorizationFlow } from '../auth/workbuddy/authorization-flow';

export const metadata: Metadata = {
  description: '由可信服务端状态驱动的平台登录入口。',
  title: '登录后管理客服',
};

export default function LoginPage() {
  return (
    <PageShell
      aside={<StatusBadge tone="info">服务端状态检查</StatusBadge>}
      description={<p>登录只建立平台会话，不能替代身份绑定、商家选择或授权同意。</p>}
      eyebrow="Authenticated Console"
      title="登录后继续 WorkBuddy 授权"
    >
      <section className="login-gate">
        <div>
          <p className="panel__eyebrow">可信状态边界</p>
          <h2>只有服务端会话可以确认登录</h2>
          <p>
            页面不从 URL、callback、环境变量中的状态字符串或前端缓存推断账号。只有同源 API
            返回的严格状态才能推进流程。
          </p>
        </div>
      </section>
      <WorkBuddyAuthorizationFlow
        apiBaseUrl={process.env['NEXT_PUBLIC_MERCHANT_API_BASE_URL']}
        backHref="/"
      />
    </PageShell>
  );
}
