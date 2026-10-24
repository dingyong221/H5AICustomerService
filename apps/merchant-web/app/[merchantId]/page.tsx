import Link from 'next/link';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { merchantAssistants, merchantAssistantGovernance, requireMerchant } from '../tenant-data';
import { merchantPath } from '../tenant-paths';
import { governanceNextStep, qualityLabels } from '../workspace/governance-model';

export default async function MerchantDashboard({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  await requireMerchant(merchantId);
  const assistants = await merchantAssistants(merchantId);
  const governance = await merchantAssistantGovernance(
    merchantId,
    assistants.slice(0, 5).map((item) => item.assistantId),
  );
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
          <span>有已发布版本</span>
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
              <li key={assistant.assistantId} className="dashboard-assistant-task">
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
                {governance.get(assistant.assistantId) ? (
                  <p className="dashboard-assistant-task__state">
                    草稿修订 {assistant.draftRevision} ·{' '}
                    {governance.get(assistant.assistantId)!.hasUnpublishedChanges
                      ? '有待发布修改'
                      : '无待发布资料修改'}{' '}
                    · {qualityLabels[governance.get(assistant.assistantId)!.quality.state]}
                  </p>
                ) : (
                  <p>发布检查暂不可用，请进入客服后刷新核对。</p>
                )}
                <p>{governanceNextStep(governance.get(assistant.assistantId) ?? null).detail}</p>
                <Link
                  href={merchantPath(
                    merchantId,
                    governanceNextStep(governance.get(assistant.assistantId) ?? null).section,
                    assistant.assistantId,
                  )}
                >
                  {governanceNextStep(governance.get(assistant.assistantId) ?? null).label} →
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
