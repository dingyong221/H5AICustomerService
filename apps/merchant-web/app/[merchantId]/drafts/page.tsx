import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';
import Link from 'next/link';

import {
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlIndustryTemplateRepository,
  type IndustryTemplateGuide,
} from '@h5cs/database';
import { toMerchantId, toMerchantUserId } from '@h5cs/domain';
import { PageShell, StatusBadge } from '@h5cs/ui';

import { currentMerchant, currentMerchantCsrfToken } from '../../account/merchant-actions';
import { MerchantLogoutForm } from '../../account/logout-form';
import { assistantListStatus } from '../../workspace/assistant-list-status';
import { CreateAssistantForm } from '../../workspace/create-assistant-form';

export const dynamic = 'force-dynamic';

export default async function MerchantWorkspacePage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) redirect('/account/login');
  const session = await currentMerchant(merchantId);
  if (!session)
    redirect(
      `/console/account/login?merchant=${merchantId}&next=${encodeURIComponent(`/${merchantId}/drafts`)}`,
    );
  const csrfToken = await currentMerchantCsrfToken();
  const database = loadDatabaseConfig();
  let assistants: Awaited<ReturnType<MySqlAssistantLifecycleRepository['listMerchantAssistants']>> =
    [];
  let ready = false;
  let templates: readonly IndustryTemplateGuide[] = [];
  let templatesReady = false;
  if (database.configured) {
    try {
      assistants = await new MySqlAssistantLifecycleRepository(
        database.config,
      ).listMerchantAssistants(toMerchantUserId(session.merchantUserId), toMerchantId(merchantId));
      ready = true;
    } catch {
      ready = false;
    }
    try {
      templates = await new MySqlIndustryTemplateRepository(database.config).listActive();
      templatesReady = true;
    } catch {
      templatesReady = false;
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
      title="客服草稿"
    >
      {ready ? (
        <>
          <section className="merchant-account-card assistant-create-card" id="create-assistant">
            <h2>客服基础资料</h2>
            <CreateAssistantForm
              merchantId={merchantId}
              idempotencyKey={randomUUID()}
              templates={templates}
              templatesReady={templatesReady}
            />
          </section>
          <section className="merchant-account-card assistant-create-card" id="assistants">
            <h2>已创建的客服</h2>
            <p>点击下方客服名称，即可进入资料编辑、知识确认、试聊和发布页面。</p>
            {assistants.length === 0 ? (
              <p>还没有客服草稿。请先填写上方基础资料并点击“创建客服草稿”。</p>
            ) : (
              <ul className="assistant-workspace-list">
                {assistants.map((assistant) => (
                  <li key={assistant.assistantId}>
                    <Link href={`/${merchantId}/drafts/${assistant.assistantId}`}>
                      <strong>{assistant.displayName}</strong>
                    </Link>
                    <span>{assistantListStatus(assistant)}</span>
                    <small>客服编号：{assistant.assistantId}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="merchant-account-card assistant-create-card" id="conversations">
            <h2>客户咨询</h2>
            <p>查看消费者咨询与人工跟进状态。客服发布后产生的咨询会出现在这里。</p>
            <Link href={`/${merchantId}/conversations`}>进入咨询管理</Link>
          </section>
        </>
      ) : (
        <p role="alert">数据库暂不可用，无法读取或创建客服。</p>
      )}
    </PageShell>
  );
}
