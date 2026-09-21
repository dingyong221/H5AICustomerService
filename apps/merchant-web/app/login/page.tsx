import type { Metadata } from 'next';
import Link from 'next/link';

import { Button, PageShell, StatusBadge } from '@h5cs/ui';

export const metadata: Metadata = {
  description: '登录后进入已有 AI 客服管理后台。',
  title: '登录后管理客服',
};

export default function LoginPage() {
  return (
    <PageShell
      aside={<StatusBadge tone="warning">需要登录</StatusBadge>}
      description={<p>管理地址只负责定位页面，不能替代身份认证或商家权限校验。</p>}
      eyebrow="Authenticated Console"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>登录 API 尚未连接</strong>
            <span>当前不能建立登录会话，管理入口保持不可用。</span>
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
            即使入口由 WorkBuddy 返回，也必须先完成登录；服务端还会校验当前账号、商家和客服权限。
          </p>
        </div>
        <div className="login-gate__actions">
          <Button disabled>登录并继续</Button>
          <Link className="quiet-link" href="/auth/workbuddy/bind">
            前往 HTTPS 安全绑定页
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
