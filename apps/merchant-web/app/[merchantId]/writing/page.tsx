import Link from 'next/link';
import { PageShell } from '@h5cs/ui';
import { requireMerchant } from '../../tenant-data';
import { currentMerchantCsrfToken } from '../../account/merchant-actions';
import { merchantPath } from '../../tenant-paths';
import { WritingWorkbench } from '../../writing/workbench';

export default async function WritingPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { merchantId } = await params;
  await requireMerchant(merchantId, merchantPath(merchantId, 'writing'));
  return (
    <PageShell
      title="客服资料填写助手"
      eyebrow="Writing Assistant"
      description={
        <p>
          用简单文字生成详细文案或多个选择。生成后核对事实，再复制到客服草稿；也可直接在草稿字段旁使用“帮我写”。
        </p>
      }
      aside={<Link href={`${merchantPath(merchantId, 'help')}#writing`}>查看使用帮助</Link>}
    >
      <p>
        <Link href={merchantPath(merchantId, 'drafts')}>返回客服草稿并填写</Link> ·
        切换内容类型会清空本页尚未使用的备选，请先复制需要的文字。
      </p>
      <WritingWorkbench merchantId={merchantId} csrfToken={await currentMerchantCsrfToken()} />
    </PageShell>
  );
}
