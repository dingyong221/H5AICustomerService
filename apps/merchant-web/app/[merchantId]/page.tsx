import Link from 'next/link';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { merchantAssistants, merchantAssistantGovernance } from '../tenant-data';
import { merchantPath } from '../tenant-paths';
import { governanceNextStep, qualityLabels } from '../workspace/governance-model';
export default async function MerchantDashboard({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  const [assistant] = await merchantAssistants(merchantId);
  const governance = assistant
    ? ((await merchantAssistantGovernance(merchantId, [assistant.assistantId])).get(
        assistant.assistantId,
      ) ?? null)
    : null;
  const next = governanceNextStep(governance);
  const path = (section: 'drafts' | 'knowledge' | 'preview' | 'publish') =>
    assistant
      ? merchantPath(merchantId, section, assistant.assistantId)
      : merchantPath(merchantId, 'drafts') + '/new';
  return (
    <PageShell
      title="工作台"
      eyebrow="My AI Assistant"
      description={
        <p>
          本商家只有一个AI客服。持续更新它的资料，所有客户通过同一个固定入口咨询，各自的对话独立保存。
        </p>
      }
      aside={
        <Link className="tenant-feature-link" href={path('drafts')}>
          {assistant ? '管理我的客服' : '开通我的AI客服'}
        </Link>
      }
    >
      {assistant ? (
        <>
          <section className="merchant-account-card assistant-create-card">
            <div className="section-heading">
              <h2>{assistant.displayName}</h2>
              <StatusBadge tone={assistant.status === 'paused' ? 'warning' : 'info'}>
                {assistant.status === 'paused'
                  ? '已暂停'
                  : assistant.activeReleaseId
                    ? '已发布'
                    : '待发布'}
              </StatusBadge>
            </div>
            <p>
              当前草稿修订 {assistant.draftRevision} ·{' '}
              {governance?.hasUnpublishedChanges ? '有待发布修改' : '无待发布资料修改'} ·{' '}
              {governance ? qualityLabels[governance.quality.state] : '发布检查暂不可用'}
            </p>
            <h3>下一步</h3>
            <p>{next.detail}</p>
            <Link
              className="tenant-feature-link"
              href={merchantPath(merchantId, next.section, assistant.assistantId)}
            >
              {next.label} →
            </Link>
          </section>
          <div className="tenant-feature-grid">
            <Link className="tenant-feature-link" href={path('drafts')}>
              基础资料 →
            </Link>
            <Link className="tenant-feature-link" href={path('knowledge')}>
              知识补充 →
            </Link>
            <Link className="tenant-feature-link" href={path('preview')}>
              效果试聊 →
            </Link>
            <Link className="tenant-feature-link" href={path('publish')}>
              发布分享 →
            </Link>
          </div>
        </>
      ) : (
        <section className="merchant-account-card assistant-create-card">
          <h2>开通你的AI客服</h2>
          <p>基础资料 → 知识补充（可上传材料）→ 效果试聊 → 发布分享。后续修改都维护同一个客服。</p>
          <Link className="tenant-feature-link" href={path('drafts')}>
            开通我的AI客服
          </Link>
        </section>
      )}
      <div className="tenant-feature-grid">
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'conversations')}>
          消费者会话 →
        </Link>
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'improvements')}>
          问题与改进 →
        </Link>
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'help')}>
          帮助中心 →
        </Link>
      </div>
    </PageShell>
  );
}
