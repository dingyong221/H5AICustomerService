import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageShell } from '@h5cs/ui';
import { merchantAssistants } from './tenant-data';
import { merchantPath } from './tenant-paths';
export async function AssistantCollection({
  merchantId,
  section,
}: {
  merchantId: string;
  section: 'knowledge' | 'preview' | 'publish';
}) {
  const [assistant] = await merchantAssistants(merchantId, merchantPath(merchantId, section));
  if (assistant) redirect(merchantPath(merchantId, section, assistant.assistantId));
  const title =
    section === 'knowledge' ? '知识补充' : section === 'preview' ? '效果试聊' : '发布分享';
  return (
    <PageShell
      title={title}
      eyebrow="Merchant Workspace"
      description={<p>先开通本商家的唯一AI客服，之后可直接进入{title}。</p>}
    >
      <Link className="tenant-feature-link" href={merchantPath(merchantId, 'drafts') + '/new'}>
        开通我的AI客服
      </Link>
    </PageShell>
  );
}
