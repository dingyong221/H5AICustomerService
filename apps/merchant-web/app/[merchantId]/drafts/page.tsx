import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageShell } from '@h5cs/ui';
import { merchantAssistants } from '../../tenant-data';
import { merchantPath } from '../../tenant-paths';
export default async function DraftsPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  const [assistant] = await merchantAssistants(merchantId, merchantPath(merchantId, 'drafts'));
  if (assistant) redirect(merchantPath(merchantId, 'drafts', assistant.assistantId));
  return (
    <PageShell
      title="AI客服管理"
      eyebrow="Merchant Assistant"
      description={<p>每个商家只有一个AI客服。开通后，资料、知识和发布都在这个客服上持续维护。</p>}
    >
      <section className="merchant-account-card assistant-create-card">
        <h2>开通你的AI客服</h2>
        <p>基础资料 → 知识补充 → 效果试聊 → 发布分享。</p>
        <Link className="tenant-feature-link" href={merchantPath(merchantId, 'drafts') + '/new'}>
          开通我的AI客服
        </Link>
      </section>
    </PageShell>
  );
}
