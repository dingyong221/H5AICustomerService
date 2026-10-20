import { randomUUID } from 'node:crypto';

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toAssistantId, toMerchantId } from '@h5cs/domain';
import { PageShell, StatusBadge } from '@h5cs/ui';

import { merchantPath } from './tenant-paths';

import { ShareAssistantLink } from './share-assistant-link';
import { currentMerchant, currentMerchantCsrfToken } from './account/merchant-actions';
import { publicApiReady } from './workspace/api-readiness';
import { ConfirmKnowledgeForm } from './workspace/confirm-knowledge-form';
import { EditDraftForm } from './workspace/edit-draft-form';
import { DraftReadinessPanel } from './workspace/draft-readiness-panel';
import { DraftRevisionNotice } from './workspace/draft-revision-notice';
import { PreviewChatForm } from './workspace/preview-chat-form';
import { PublishAssistantForm } from './workspace/publish-assistant-form';
import { publicationPolicy, publicAssistantUrl } from './workspace/publication-policy';
import { workerReady } from './workspace/worker-readiness';
import { ImprovementSummaryPanel } from './improvements/improvement-summary';

export const dynamic = 'force-dynamic';

export async function AssistantView({
  merchantId,
  assistantId,
  section,
}: {
  merchantId: string;
  assistantId: string;
  section: 'drafts' | 'knowledge' | 'publish';
}) {
  if (!/^[0-9a-f]{32}$/u.test(merchantId) || !/^[0-9a-f]{32}$/u.test(assistantId)) notFound();
  const session = await currentMerchant(merchantId);
  if (!session) {
    const nextPath = merchantPath(merchantId, section, assistantId);
    redirect(`/console/account/login?merchant=${merchantId}&next=${encodeURIComponent(nextPath)}`);
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
    ['人工联系说明', assistant.draft.humanContact || '尚未提供。此处不实时转接人工。'],
  ] as const;
  return (
    <PageShell
      aside={<Link href={merchantPath(merchantId)}>返回商家工作台</Link>}
      description={<p>核对本次录入的真实资料。确认只建立知识依据，不会自动向消费者开放客服。</p>}
      eyebrow="Assistant Draft"
      title={
        section === 'drafts'
          ? assistant.displayName
          : section === 'knowledge'
            ? '知识库'
            : '测试与发布'
      }
    >
      <p>
        当前客服：{assistant.displayName} · 商家编号：{merchantId}
      </p>
      <div className="tenant-feature-grid">
        <Link href={merchantPath(merchantId, 'drafts', assistantId)}>客服草稿</Link>
        <Link href={merchantPath(merchantId, 'knowledge', assistantId)}>知识库</Link>
        <Link href={merchantPath(merchantId, 'publish', assistantId)}>测试与发布</Link>
      </div>
      <p>
        <Link href={`${merchantPath(merchantId, 'help')}#${section}`}>查看本页操作帮助</Link>
      </p>
      <section className="merchant-account-card assistant-detail-card" id="draft">
        <div className="section-heading">
          <h2>草稿修订 {assistant.draftRevision}</h2>
          <StatusBadge tone={assistant.knowledgeConfirmed ? 'info' : 'warning'}>
            {assistant.knowledgeConfirmed ? '资料已确认' : '资料待确认'}
          </StatusBadge>
        </div>
        <DraftRevisionNotice
          key={assistantId}
          revision={assistant.draftRevision}
          knowledgeConfirmed={assistant.knowledgeConfirmed}
        />
        <dl className="assistant-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <DraftReadinessPanel draft={assistant.draft} />
      {section !== 'publish' && (
        <section className="merchant-account-card assistant-detail-card">
          <h2>修订草稿</h2>
          <p>修改后将产生新修订，已有资料确认失效，需重新核对。</p>
          <EditDraftForm
            key={assistant.draftRevision}
            csrfToken={csrfToken}
            returnPath={merchantPath(merchantId, section, assistantId)}
            merchantId={merchantId}
            assistantId={assistantId}
            draftRevision={assistant.draftRevision}
            draft={assistant.draft}
          />
        </section>
      )}
      {section === 'knowledge' && (
        <section className="merchant-account-card assistant-detail-card" id="knowledge">
          <h2>商家确认</h2>
          <p>只有经你确认的资料才会进入正式版本。价格、优惠、库存与承诺不得由模型自行补造。</p>
          <ConfirmKnowledgeForm
            key={`${assistantId}:${assistant.draftRevision}`}
            merchantId={merchantId}
            assistantId={assistantId}
            draftRevision={assistant.draftRevision}
            alreadyConfirmed={assistant.knowledgeConfirmed}
          />
        </section>
      )}
      {section === 'publish' && (
        <section className="merchant-account-card assistant-detail-card" id="release">
          <h2>发布前试聊</h2>
          <p>用当前未发布草稿测试回答，核对服务范围、价格和资料不足时的回复。</p>
          <PreviewChatForm
            merchantId={merchantId}
            assistantId={assistantId}
            draftRevision={assistant.draftRevision}
            csrfToken={csrfToken}
            available={workerAvailable && assistant.status !== 'paused'}
          />
        </section>
      )}
      {section === 'publish' && (
        <section className="merchant-account-card assistant-detail-card">
          <h2>发布与消费者链接</h2>
          {!assistant.knowledgeConfirmed ? (
            <div className="assistant-detail-card" id="knowledge-confirmation">
              <h3>先确认当前修订的业务资料</h3>
              <p>
                发布前请逐项核对上方草稿修订 {assistant.draftRevision}{' '}
                的资料。确认后会更新本页的发布条件， 不会自动向消费者开放客服。
              </p>
              <ConfirmKnowledgeForm
                key={`${assistantId}:${assistant.draftRevision}`}
                merchantId={merchantId}
                assistantId={assistantId}
                draftRevision={assistant.draftRevision}
                alreadyConfirmed={false}
              />
            </div>
          ) : null}
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
      )}
      <ImprovementSummaryPanel
        merchantId={merchantId}
        merchantUserId={session.merchantUserId}
        assistantId={assistantId}
      />
    </PageShell>
  );
}
