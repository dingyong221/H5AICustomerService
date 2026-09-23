import Link from 'next/link';

import { PageShell, StatusBadge } from '@h5cs/ui';

export default function MerchantDashboardPage() {
  return (
    <PageShell
      description={
        <p>
          从平台领取商家后台，录入真实业务资料，核对并发布后才会生成可分享的消费者 AI 客服链接。
        </p>
      }
      eyebrow="Merchant Console"
      notice={
        <div className="connection-banner" role="status">
          <span aria-hidden="true" className="connection-banner__pulse" />
          <div>
            <strong>管理操作需要商家登录</strong>
            <span>是否可以创建和发布，以登录后的服务端数据及运行状态为准。</span>
          </div>
        </div>
      }
      title="管理你的 AI 客服"
    >
      <div className="workbuddy-choice-grid">
        <article>
          <div>
            <StatusBadge tone="info">已有商家后台</StatusBadge>
            <h2>登录后继续配置</h2>
            <p>创建客服草稿、确认资料、发布版本，并获取固定的消费者 H5 链接。</p>
          </div>
          <Link className="workbuddy-action" href="/account/login">
            登录商家后台
          </Link>
        </article>
        <article>
          <div>
            <StatusBadge tone="warning">首次领取</StatusBadge>
            <h2>使用平台开通链接</h2>
            <p>请打开平台运营提供的一次性领取链接，设置负责人账号后进入自己的工作台。</p>
          </div>
          <p>领取链接只在平台创建商家时生成，请向运营人员获取。</p>
        </article>
        <article>
          <div>
            <StatusBadge>WorkBuddy</StatusBadge>
            <h2>按步骤整理业务资料</h2>
            <p>在完成安全身份连接后，按行业、商品服务和售卖策略整理客服草稿。</p>
          </div>
          <Link className="workbuddy-action" href="/onboarding">
            查看生成引导
          </Link>
        </article>
      </div>
    </PageShell>
  );
}
