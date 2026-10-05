import Link from 'next/link';
import { PageShell } from '@h5cs/ui';
import { merchantAssistants } from './tenant-data';
import { merchantPath } from './tenant-paths';
import { assistantListStatus } from './workspace/assistant-list-status';

export async function AssistantCollection({
  merchantId,
  section,
}: {
  merchantId: string;
  section: 'knowledge' | 'publish';
}) {
  const assistants = await merchantAssistants(merchantId, merchantPath(merchantId, section));
  const title = section === 'knowledge' ? '知识库' : '测试与发布';
  return (
    <PageShell
      title={title}
      eyebrow="Merchant Workspace"
      description={<p>商家编号：{merchantId}。请选择本商家的客服，进入对应功能页面。</p>}
    >
      <section className="merchant-account-card assistant-create-card">
        <h2>选择要{section === 'knowledge' ? '维护资料' : '试聊和发布'}的客服</h2>
        {assistants.length ? (
          <ul className="assistant-workspace-list">
            {assistants.map((assistant) => (
              <li key={assistant.assistantId}>
                <Link href={merchantPath(merchantId, section, assistant.assistantId)}>
                  {assistant.displayName}
                </Link>
                <span>{assistantListStatus(assistant)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>本商家还没有客服。请先到“客服草稿”创建。</p>
        )}
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'drafts')}>
          进入客服草稿
        </Link>
      </section>
    </PageShell>
  );
}
