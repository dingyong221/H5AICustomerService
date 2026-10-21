import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { merchantAssistants } from '../../tenant-data';
import { merchantPath } from '../../tenant-paths';

export const dynamic = 'force-dynamic';

export default async function AssistantListPage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) notFound();
  const assistants = await merchantAssistants(merchantId, merchantPath(merchantId, 'drafts'));
  return (
    <PageShell
      title="客服列表"
      eyebrow="AI Customer Service"
      description={
        <p>选择一个客服继续配置，或创建新的客服。每个客服的资料与消费者链接独立保存。</p>
      }
      aside={
        <Link className="tenant-feature-link" href={`${merchantPath(merchantId, 'drafts')}/new`}>
          新建客服
        </Link>
      }
    >
      <section className="merchant-account-card assistant-create-card">
        {assistants.length ? (
          <ul className="assistant-workspace-list">
            {assistants.map((assistant) => (
              <li key={assistant.assistantId}>
                <div>
                  <Link href={merchantPath(merchantId, 'drafts', assistant.assistantId)}>
                    <strong>{assistant.displayName}</strong>
                  </Link>
                  <p>
                    {assistant.status === 'paused'
                      ? '服务已暂停'
                      : assistant.activeReleaseId
                        ? '已有上线版本，修改草稿不会影响当前服务'
                        : '尚未发布，完成配置后可分享给消费者'}
                  </p>
                </div>
                <StatusBadge tone={assistant.status === 'paused' ? 'warning' : 'info'}>
                  {assistant.status === 'paused'
                    ? '已暂停'
                    : assistant.activeReleaseId
                      ? '已发布'
                      : '草稿'}
                </StatusBadge>
                <Link
                  className="tenant-feature-link"
                  href={merchantPath(
                    merchantId,
                    assistant.activeReleaseId ? 'publish' : 'drafts',
                    assistant.assistantId,
                  )}
                >
                  {assistant.activeReleaseId ? '管理与分享' : '继续配置'}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="assistant-empty-state">
            <h2>创建你的第一个 AI 客服</h2>
            <p>填写资料 → 补充知识 → 效果试聊 → 发布分享。</p>
            <Link
              className="tenant-feature-link"
              href={`${merchantPath(merchantId, 'drafts')}/new`}
            >
              新建客服
            </Link>
          </div>
        )}
      </section>
    </PageShell>
  );
}
