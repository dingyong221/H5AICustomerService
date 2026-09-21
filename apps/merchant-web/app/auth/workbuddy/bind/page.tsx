import type { Metadata } from 'next';
import Link from 'next/link';

import { Button, PageShell, StatusBadge } from '@h5cs/ui';

export const metadata: Metadata = {
  description: '在本站 HTTPS 页面安全绑定 WorkBuddy 身份。',
  title: 'WorkBuddy 安全绑定',
};

export default function WorkBuddyBindingPage() {
  return (
    <PageShell
      aside={<StatusBadge tone="warning">需要安全绑定</StatusBadge>}
      description={<p>授权操作仅在本站 HTTPS 页面完成，并由服务端创建可撤销的登录会话。</p>}
      eyebrow="Secure Binding"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>绑定 API 尚未连接</strong>
            <span>当前不能开始授权，也不会在浏览器本地写入模拟身份。</span>
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
          <p>正式环境只接受平台配置的同源回调；未知来源和跨域管理地址将被拒绝。</p>
        </div>
        <span aria-hidden="true" className="auth-placeholder__number">
          02
        </span>
        <div>
          <h2>由服务端完成身份交换</h2>
          <p>绑定结果必须由服务端签发并校验，页面本身不能把 URL 或客户端状态当作授权。</p>
        </div>
        <span aria-hidden="true" className="auth-placeholder__number">
          03
        </span>
        <div>
          <h2>登录后继续操作</h2>
          <p>绑定成功仍需有效登录会话，才能创建客服或进入已有客服管理页。</p>
        </div>
        <div className="auth-placeholder__actions">
          <Button disabled>开始安全绑定</Button>
          <Link className="quiet-link" href="/">
            返回工作台
          </Link>
        </div>
      </section>
    </PageShell>
  );
}
