import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';
import Link from 'next/link';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { PageShell, StatusBadge } from '@h5cs/ui';

import { currentMerchant, currentMerchantCsrfToken } from '../../account/merchant-actions';
import { MerchantLogoutForm } from '../../account/logout-form';
import { assistantListStatus } from '../assistant-list-status';
import { CreateAssistantForm } from '../create-assistant-form';

export const dynamic = 'force-dynamic';

export default async function MerchantWorkspacePage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) redirect('/account/login');
  const session = await currentMerchant(merchantId);
  if (!session) redirect(`/account/login?merchant=${merchantId}`);
  const csrfToken = await currentMerchantCsrfToken();
  const database = loadDatabaseConfig();
  let assistants: Awaited<ReturnType<MySqlAssistantLifecycleRepository['listMerchantAssistants']>> =
    [];
  let ready = false;
  if (database.configured) {
    try {
      assistants = await new MySqlAssistantLifecycleRepository(
        database.config,
      ).listMerchantAssistants(toMerchantUserId(session.merchantUserId), toMerchantId(merchantId));
      ready = true;
    } catch {
      ready = false;
    }
  }
  return (
    <PageShell
      aside={
        <div className="merchant-workspace-aside">
          <StatusBadge tone={ready ? 'info' : 'warning'}>
            {ready ? '已连接商家数据' : '数据暂不可用'}
          </StatusBadge>
          <MerchantLogoutForm merchantId={merchantId} csrfToken={csrfToken} />
        </div>
      }
      description={
        <p>先用真实业务资料生成可编辑客服草稿。完成知识、试聊和发布校验后才会开放消费者链接。</p>
      }
      eyebrow="Merchant Workspace"
      title="创建你的 AI 客服"
    >
      {ready ? (
        <>
          <section className="merchant-account-card assistant-create-card">
            <h2>客服基础资料</h2>
            <CreateAssistantForm merchantId={merchantId} idempotencyKey={randomUUID()} />
          </section>
          <section className="merchant-account-card assistant-create-card">
            <h2>已创建的客服</h2>
            {assistants.length === 0 ? (
              <p>还没有客服草稿。</p>
            ) : (
              <ul className="assistant-workspace-list">
                {assistants.map((assistant) => (
                  <li key={assistant.assistantId}>
                    <Link href={`/workspace/${merchantId}/assistants/${assistant.assistantId}`}>
                      <strong>{assistant.displayName}</strong>
                    </Link>
                    <span>{assistantListStatus(assistant)}</span>
                    <small>客服编号：{assistant.assistantId}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <p role="alert">数据库暂不可用，无法读取或创建客服。</p>
      )}
    </PageShell>
  );
}
