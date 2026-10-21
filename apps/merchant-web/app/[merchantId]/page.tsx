import Link from 'next/link';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { merchantAssistants, requireMerchant } from '../tenant-data';
import { merchantPath } from '../tenant-paths';

export default async function MerchantDashboard({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  await requireMerchant(merchantId);
  const assistants = await merchantAssistants(merchantId);
  const published = assistants.filter(
    (assistant) => assistant.activeReleaseId && assistant.status === 'active',
  );
  return (
    <PageShell
      title="工作台"
      eyebrow="Overview"
      description={<p>配置客服、上线分享，再从消费者咨询中持续完善知识。</p>}
      aside={
        <Link className="tenant-feature-link" href={`${merchantPath(merchantId, 'drafts')}/new`}>
          新建客服
        </Link>
      }
    >
      <div className="tenant-feature-grid merchant-overview-stats">
        <section className="merchant-account-card">
          <span>全部客服</span>
          <h2>{assistants.length}</h2>
          <Link href={merchantPath(merchantId, 'drafts')}>查看客服列表</Link>
        </section>
        <section className="merchant-account-card">
          <span>服务中</span>
          <h2>{published.length}</h2>
          <Link href={merchantPath(merchantId, 'publish')}>管理与分享</Link>
        </section>
        <section className="merchant-account-card">
          <span>未发布</span>
          <h2>{assistants.filter((assistant) => !assistant.activeReleaseId).length}</h2>
          <Link href={merchantPath(merchantId, 'drafts')}>继续配置</Link>
        </section>
      </div>
      <section className="merchant-account-card assistant-create-card">
        <div className="section-heading">
          <h2>我的客服</h2>
          <Link href={merchantPath(merchantId, 'drafts')}>全部客服 →</Link>
        </div>
        {assistants.length ? (
          <ul className="assistant-workspace-list">
            {assistants.slice(0, 5).map((assistant) => (
              <li key={assistant.assistantId}>
                <Link href={merchantPath(merchantId, 'drafts', assistant.assistantId)}>
                  <strong>{assistant.displayName}</strong>
                </Link>
                <StatusBadge tone={assistant.status === 'paused' ? 'warning' : 'info'}>
                  {assistant.status === 'paused'
                    ? '已暂停'
                    : assistant.activeReleaseId
                      ? '已发布'
                      : '待配置'}
                </StatusBadge>
                <Link
                  href={merchantPath(
                    merchantId,
                    assistant.activeReleaseId ? 'publish' : 'drafts',
                    assistant.assistantId,
                  )}
                >
                  {assistant.activeReleaseId ? '发布与分享' : '继续配置'} →
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="assistant-empty-state">
            <h3>从第一个客服开始</h3>
            <p>基础资料 → 知识补充（支持上传文件）→ 效果试聊 → 发布分享。</p>
            <Link
              className="tenant-feature-link"
              href={`${merchantPath(merchantId, 'drafts')}/new`}
            >
              新建客服
            </Link>
          </div>
        )}
      </section>
      <div className="tenant-feature-grid">
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'conversations')}>
          查看消费者咨询 →
        </Link>
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'improvements')}>
          处理问题与改进 →
        </Link>
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'help')}>
          帮助中心 →
        </Link>
      </div>
    </PageShell>
  );
}
