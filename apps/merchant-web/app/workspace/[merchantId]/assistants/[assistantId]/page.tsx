import { randomUUID } from 'node:crypto';

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toAssistantId, toMerchantId } from '@h5cs/domain';
import { PageShell, StatusBadge } from '@h5cs/ui';

import { ShareAssistantLink } from '../../../../share-assistant-link';
import { currentMerchant, currentMerchantCsrfToken } from '../../../../account/merchant-actions';
import { publicApiReady } from '../../../api-readiness';
import { ConfirmKnowledgeForm } from '../../../confirm-knowledge-form';
import { EditDraftForm } from '../../../edit-draft-form';
import { PublishAssistantForm } from '../../../publish-assistant-form';
import { publicationPolicy, publicAssistantUrl } from '../../../publication-policy';
import { workerReady } from '../../../worker-readiness';

export const dynamic = 'force-dynamic';

export default async function AssistantDraftPage({
  params,
}: {
  params: Promise<{ merchantId: string; assistantId: string }>;
}) {
  const { merchantId, assistantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId) || !/^[0-9a-f]{32}$/u.test(assistantId)) notFound();
  const session = await currentMerchant(merchantId);
  if (!session) {
    const nextPath = `/workspace/${merchantId}/assistants/${assistantId}`;
    redirect(`/account/login?merchant=${merchantId}&next=${encodeURIComponent(nextPath)}`);
  }
  const database = loadDatabaseConfig();
  if (!database.configured) return <p role="alert">数据库尚未配置，无法读取客服草稿。</p>;
  let assistant;
  try {
    assistant = await new MySqlAssistantLifecycleRepository(database.config).findManagementSnapshot(
      toMerchantId(merchantId),
      toAssistantId(assistantId),
    );
  } catch {
    return <p role="alert">客服草稿暂不可用，请稍后重试。</p>;
  }
  if (!assistant) notFound();
  const policy = publicationPolicy();
  const [workerAvailable, publicApiAvailable] = policy.ready
    ? await Promise.all([workerReady(), publicApiReady()])
    : [false, false];
  const csrfToken = await currentMerchantCsrfToken();
  let verifiedPublicUrl: string | null = null;
  if (
    policy.ready &&
    workerAvailable &&
    publicApiAvailable &&
    assistant.status === 'active' &&
    assistant.activeReleaseId
  ) {
    try {
      const publicSnapshot = await new MySqlAssistantLifecycleRepository(
        database.config,
      ).findPublicSnapshot(assistant.publicSlug);
      if (publicSnapshot?.releaseRef === assistant.activeReleaseId) {
        verifiedPublicUrl = publicAssistantUrl(policy.consumerOrigin, assistant.publicSlug);
      }
    } catch {
      verifiedPublicUrl = null;
    }
  }
  const publishReady =
    policy.ready &&
    assistant.knowledgeConfirmed &&
    assistant.status !== 'paused' &&
    workerAvailable &&
    publicApiAvailable;
  const publishReason = !policy.ready
    ? policy.reason
    : !assistant.knowledgeConfirmed
      ? '请先确认当前修订的业务资料。'
      : assistant.status === 'paused'
        ? '客服已暂停，需先恢复服务。'
        : !workerAvailable
          ? 'AI 对话服务尚未就绪，请稍后再试。'
          : !publicApiAvailable
            ? '公开会话服务尚未就绪，请稍后再试。'
            : null;
  const facts = [
    ['细分行业', assistant.draft.industry],
    ['业务范围', assistant.draft.businessScope],
    ['商品或服务资料', assistant.draft.materialsSummary],
    ['价格与条件', assistant.draft.pricingSummary],
    ['优惠与售卖策略', assistant.draft.promotionSummary],
    ['欢迎语', assistant.draft.welcomeMessage],
    ['资料不足时的回复', assistant.draft.insufficientInfoMessage],
  ] as const;
  return (
    <PageShell
      aside={<Link href={`/workspace/${merchantId}`}>返回商家工作台</Link>}
      description={<p>核对本次录入的真实资料。确认只建立知识依据，不会自动向消费者开放客服。</p>}
      eyebrow="Assistant Draft"
      title={assistant.displayName}
    >
      <section className="merchant-account-card assistant-detail-card">
        <div className="section-heading">
          <h2>草稿修订 {assistant.draftRevision}</h2>
          <StatusBadge tone={assistant.knowledgeConfirmed ? 'info' : 'warning'}>
            {assistant.knowledgeConfirmed ? '资料已确认' : '资料待确认'}
          </StatusBadge>
        </div>
        <dl className="assistant-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="merchant-account-card assistant-detail-card">
        <h2>修订草稿</h2>
        <p>修改后将产生新修订，已有资料确认失效，需重新核对。</p>
        <EditDraftForm
          merchantId={merchantId}
          assistantId={assistantId}
          draftRevision={assistant.draftRevision}
          draft={assistant.draft}
        />
      </section>
      <section className="merchant-account-card assistant-detail-card">
        <h2>商家确认</h2>
        <p>只有经你确认的资料才会进入正式版本。价格、优惠、库存与承诺不得由模型自行补造。</p>
        <ConfirmKnowledgeForm
          merchantId={merchantId}
          assistantId={assistantId}
          draftRevision={assistant.draftRevision}
          alreadyConfirmed={assistant.knowledgeConfirmed}
        />
      </section>
      <section className="merchant-account-card assistant-detail-card">
        <h2>发布与消费者链接</h2>
        {assistant.activeReleaseId ? (
          <div>
            <p>
              已有线上版本：{assistant.activeReleaseId}。
              {!verifiedPublicUrl ? ' 当前公开服务未通过运行态校验，请勿分享链接。' : null}
            </p>
            {verifiedPublicUrl ? (
              <ShareAssistantLink
                expectedOrigin={policy.ready ? policy.consumerOrigin : ''}
                href={verifiedPublicUrl}
              />
            ) : null}
          </div>
        ) : (
          <p>尚未发布。确认资料不会自动开放消费者咨询。</p>
        )}
        <PublishAssistantForm
          merchantId={merchantId}
          assistantId={assistantId}
          draftRevision={assistant.draftRevision}
          csrfToken={csrfToken}
          idempotencyKey={randomUUID()}
          ready={publishReady}
          reason={publishReason}
          consumerOrigin={policy.ready ? policy.consumerOrigin : null}
        />
      </section>
    </PageShell>
  );
}
