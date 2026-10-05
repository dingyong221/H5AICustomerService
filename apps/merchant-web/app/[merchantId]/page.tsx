import Link from 'next/link';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { merchantAssistants } from '../tenant-data';
import { merchantPath } from '../tenant-paths';

export default async function MerchantDashboard({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  const assistants = await merchantAssistants(merchantId);
  return (
    <PageShell
      title="商家工作台"
      eyebrow="Merchant Workspace"
      aside={<StatusBadge tone="info">商家已登录</StatusBadge>}
      description={<p>商家编号：{merchantId}。这里的资料和操作仅属于当前商家。</p>}
    >
      <section className="merchant-account-card assistant-create-card">
        <h2>开始配置 AI 客服</h2>
        <p>当前有 {assistants.length} 个客服。依次完成草稿、知识资料确认、试聊与发布。</p>
        <div className="tenant-feature-grid">
          <Link className="tenant-feature-link" href={merchantPath(merchantId, 'drafts')}>
            客服草稿
          </Link>
          <Link className="tenant-feature-link" href={merchantPath(merchantId, 'knowledge')}>
            知识库
          </Link>
          <Link className="tenant-feature-link" href={merchantPath(merchantId, 'publish')}>
            测试与发布
          </Link>
          <Link className="tenant-feature-link" href={merchantPath(merchantId, 'conversations')}>
            咨询管理
          </Link>
        </div>
        {!assistants.length ? (
          <p>商家已开通。下一步请点击“客服草稿”，填写业务资料并创建第一个客服。</p>
        ) : null}
      </section>
    </PageShell>
  );
}
