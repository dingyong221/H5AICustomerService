import Link from 'next/link';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { merchantAssistants, merchantAssistantGovernance } from '../tenant-data';
import { merchantPath } from '../tenant-paths';
import { qualityLabels } from '../workspace/governance-model';
import { SetupProgressPanel } from '../workspace/setup-progress-panel';
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
          {assistant ? 'AI客服管理' : '开通我的AI客服'}
        </Link>
      }
    >
      <SetupProgressPanel
        merchantId={merchantId}
        assistant={assistant ?? null}
        governance={governance}
      />
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
              {governance
                ? governance.hasUnpublishedChanges
                  ? '有待发布修改'
                  : '无待发布资料修改'
                : '待发布状态待核对'}{' '}
              · {governance ? qualityLabels[governance.quality.state] : '发布检查暂不可用'}
            </p>
          </section>
        </>
      ) : null}
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
