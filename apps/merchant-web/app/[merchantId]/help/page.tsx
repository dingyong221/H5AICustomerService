import Link from 'next/link';
import { PageShell } from '@h5cs/ui';
import { HelpCenter } from '../../help/help-center';
import { requireMerchant } from '../../tenant-data';
import { merchantPath } from '../../tenant-paths';

export default async function HelpPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  await requireMerchant(merchantId, merchantPath(merchantId, 'help'));
  return (
    <PageShell
      title="帮助中心"
      eyebrow="Merchant Help"
      description={
        <p>按任务找到操作步骤，也可下载完整使用手册。下方操作入口会回到你自己的商家后台。</p>
      }
      aside={<Link href={merchantPath(merchantId)}>返回商家工作台</Link>}
    >
      <HelpCenter merchantId={merchantId} />
    </PageShell>
  );
}
