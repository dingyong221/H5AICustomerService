import type { Metadata } from 'next';

import { PageShell, StatusBadge } from '@h5cs/ui';

import { WorkBuddyAuthorizationFlow } from '../authorization-flow';

export const metadata: Metadata = {
  description: '由可信服务端状态驱动的WorkBuddy身份绑定与商家确认页面。',
  title: 'WorkBuddy 安全绑定',
};

export default function WorkBuddyBindingPage() {
  return (
    <PageShell
      aside={<StatusBadge tone="info">服务端状态检查</StatusBadge>}
      description={<p>身份绑定与商家候选只能来自服务端会话和权威Membership。</p>}
      eyebrow="Secure Binding"
      title="绑定身份并确认授权商家"
    >
      <section className="login-gate">
        <div>
          <p className="panel__eyebrow">0 / 1 / 多商家</p>
          <h2>商家数量由服务端计算</h2>
          <p>
            0个商家不能继续；1个商家仍需明确consent；多个商家不默认选择。页面不会读取query中的商家、账号、code或state作为授权事实。
          </p>
        </div>
      </section>
      <WorkBuddyAuthorizationFlow
        apiBaseUrl={process.env['NEXT_PUBLIC_MERCHANT_API_BASE_URL']}
        backHref="/login"
      />
    </PageShell>
  );
}
