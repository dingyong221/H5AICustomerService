import type { Metadata } from 'next';

import { PageShell, StatusBadge } from '@h5cs/ui';

import { AssistantManagement } from './assistant-management';

export const metadata: Metadata = {
  description: '读取可信草稿快照，完成发布检查并安全发布客服。',
  title: '客服草稿与发布',
};

export default async function AssistantManagementPage({
  params,
}: {
  params: Promise<{ assistantRef: string }>;
}) {
  const { assistantRef } = await params;

  return (
    <PageShell
      aside={<StatusBadge tone="info">服务端事实驱动</StatusBadge>}
      description={
        <p>URL 中的客服引用只用于定位；访问权、草稿 revision 和发布结果全部由服务端裁决。</p>
      }
      eyebrow="Assistant Management"
      title="客服草稿与发布"
    >
      <AssistantManagement
        apiBaseUrl={process.env['NEXT_PUBLIC_MERCHANT_API_BASE_URL']}
        assistantRef={assistantRef}
      />
    </PageShell>
  );
}
