import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageShell } from '@h5cs/ui';
import { merchantAssistants } from './tenant-data';
import { merchantPath } from './tenant-paths';
import { assistantListStatus } from './workspace/assistant-list-status';

export async function AssistantCollection({
  merchantId,
  section,
}: {
  merchantId: string;
  section: 'knowledge' | 'preview' | 'publish';
}) {
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) notFound();
  const assistants = await merchantAssistants(merchantId, merchantPath(merchantId, section));
  const title =
    section === 'knowledge' ? '知识补充' : section === 'preview' ? '效果试聊' : '发布分享';
  return (
    <PageShell
      title={title}
      eyebrow="Merchant Workspace"
      description={<p>先选择客服，再进入{title}。不会修改其他客服的资料。</p>}
    >
      <p>
        <Link href={`${merchantPath(merchantId, 'help')}#${section}`}>查看操作帮助</Link>
      </p>
      <section className="merchant-account-card assistant-create-card">
        <h2>选择客服</h2>
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
          <p>本商家还没有客服，请先新建客服。</p>
        )}
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'drafts')}>
          返回客服列表
        </Link>
      </section>
    </PageShell>
  );
}
