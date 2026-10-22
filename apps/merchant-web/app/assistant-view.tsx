import { randomUUID } from 'node:crypto';

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import {
  loadDatabaseConfig,
  MySqlAssistantLifecycleRepository,
  MySqlKnowledgeMaterialRepository,
  type KnowledgeMaterial,
} from '@h5cs/database';
import { toAssistantId, toMerchantId } from '@h5cs/domain';
import { PageShell, StatusBadge } from '@h5cs/ui';

import { merchantPath } from './tenant-paths';
import {
  AssistantWorkflowActions,
  AssistantWorkflowSteps,
  assistantWorkflowSteps,
  type AssistantWorkflowSection,
} from './assistant-workflow';

import { ShareAssistantLink } from './share-assistant-link';
import { currentMerchant, currentMerchantCsrfToken } from './account/merchant-actions';
import { publicApiReady } from './workspace/api-readiness';
import { EditDraftForm } from './workspace/edit-draft-form';
import { DraftReadinessPanel } from './workspace/draft-readiness-panel';
import { DraftRevisionNotice } from './workspace/draft-revision-notice';
import { PreviewChatForm } from './workspace/preview-chat-form';
import { PublishAssistantForm } from './workspace/publish-assistant-form';
import {
  publicationPolicy,
  publicAssistantUrl,
  publicSharingOrigin,
} from './workspace/publication-policy';
import { workerReady } from './workspace/worker-readiness';
import { MaterialManager } from './knowledge/material-manager';

export const dynamic = 'force-dynamic';

export async function AssistantView({
  merchantId,
  assistantId,
  section,
}: {
  merchantId: string;
  assistantId: string;
  section: AssistantWorkflowSection;
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
  let materials: readonly KnowledgeMaterial[] | null = null;
  if (section === 'knowledge') {
    try {
      materials = await new MySqlKnowledgeMaterialRepository(database.config).list(
        merchantId,
        assistantId,
        session.merchantUserId,
      );
    } catch {
      /* Do not confuse unavailable with empty. */
    }
  }
  const sharingOrigin = publicSharingOrigin();
  // Only an actually persisted release earns a share link. Its address is not a
  // transient readiness result: editing or a Worker outage must not erase it.
  const persistedPublicUrl =
    assistant.activeReleaseId && sharingOrigin
      ? publicAssistantUrl(sharingOrigin, assistant.publicSlug)
      : null;
  const publishReady =
    policy.ready && assistant.status !== 'paused' && workerAvailable && publicApiAvailable;
  const publishReason = !policy.ready
    ? policy.reason
    : assistant.status === 'paused'
      ? '客服已暂停，需先恢复服务。'
      : !workerAvailable
        ? 'AI 对话服务尚未就绪，请稍后再试。'
        : !publicApiAvailable
          ? '公开会话服务尚未就绪，请稍后再试。'
          : null;
  const publishPanel = (
    <section className="merchant-account-card assistant-detail-card" id="release">
      <h2>确认资料并发布</h2>
      <p>
        {assistant.activeReleaseId
          ? '已有已发布版本。发布当前修订后，新咨询使用新版，原固定链接不变。'
          : '当前尚未发布。确认并发布后，即可获得发给消费者的固定链接。'}
      </p>
      <PublishAssistantForm
        key={`${assistantId}:${assistant.draftRevision}`}
        merchantId={merchantId}
        assistantId={assistantId}
        draftRevision={assistant.draftRevision}
        csrfToken={csrfToken}
        idempotencyKey={randomUUID()}
        ready={publishReady}
        reason={publishReason}
        consumerOrigin={sharingOrigin}
        hasPublishedLink={persistedPublicUrl !== null}
      />
    </section>
  );
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
  const step = assistantWorkflowSteps.find((item) => item.section === section)!;
  return (
    <div className="assistant-workflow-layout">
      <PageShell
        aside={<Link href={merchantPath(merchantId, 'drafts')}>返回客服列表</Link>}
        description={<p>{step.description}</p>}
        eyebrow="AI 客服 / 配置与发布"
        title={step.title}
      >
        <div className="assistant-workflow-context">
          <p>
            当前客服：<strong>{assistant.displayName}</strong>
          </p>
          <span>草稿修订 {assistant.draftRevision}</span>
          <StatusBadge tone={assistant.activeReleaseId ? 'success' : 'warning'}>
            {assistant.activeReleaseId ? '已有发布版本' : '尚未发布'}
          </StatusBadge>
          <Link href={`${merchantPath(merchantId, 'help')}#${section}`}>本步帮助</Link>
        </div>
        <AssistantWorkflowSteps
          merchantId={merchantId}
          assistantId={assistantId}
          section={section}
        />
        {assistant.activeReleaseId ? (
          <section
            aria-labelledby="consumer-link-title"
            className="assistant-fixed-link"
            id="consumer-link"
            tabIndex={-1}
          >
            <div className="assistant-fixed-link__heading">
              <h2 id="consumer-link-title">固定消费者链接</h2>
              <span>已发布 · 新版本沿用此地址</span>
            </div>
            <details open={section === 'publish'}>
              <summary>查看链接与二维码</summary>
              {persistedPublicUrl && sharingOrigin ? (
                <ShareAssistantLink expectedOrigin={sharingOrigin} href={persistedPublicUrl} />
              ) : (
                <p role="alert">
                  已发布版本保留，但消费者链接的正式域名配置暂不可用，请联系运营核对。
                </p>
              )}
            </details>
            {!publishReady ? (
              <p role="status">
                固定地址仍保留，当前服务暂不可用，建议恢复后再分享。{publishReason}
              </p>
            ) : null}
          </section>
        ) : null}
        {section === 'drafts' ? (
          <section className="merchant-account-card assistant-detail-card" id="draft">
            <h2>填写业务资料</h2>
            <p className="workflow-hint">
              保存本步后，继续上传商品表、说明文档或 FAQ。已有线上版本不受草稿编辑影响。
            </p>
            <DraftRevisionNotice
              key={assistantId}
              revision={assistant.draftRevision}
              knowledgeConfirmed={assistant.knowledgeConfirmed}
            />
            <EditDraftForm
              key={assistantId}
              csrfToken={csrfToken}
              returnPath={merchantPath(merchantId, 'drafts', assistantId)}
              continueHref={merchantPath(merchantId, 'knowledge', assistantId)}
              merchantId={merchantId}
              assistantId={assistantId}
              draftRevision={assistant.draftRevision}
              draft={assistant.draft}
            />
          </section>
        ) : null}
        {section === 'knowledge' ? (
          <>
            <p className="workflow-note">
              有文件就上传整理；没有文件，可直接使用已保存的文字资料进入试聊。上传本身不会自动写入知识或发布。
            </p>
            <MaterialManager
              merchantId={merchantId}
              assistantId={assistantId}
              csrfToken={csrfToken}
              revision={assistant.draftRevision}
              materials={materials}
            />
            <details className="workflow-disclosure">
              <summary>查看已保存的商品与服务资料</summary>
              <p className="workflow-saved-text">{assistant.draft.materialsSummary}</p>
              <Link href={merchantPath(merchantId, 'drafts', assistantId)}>
                返回基础资料修改价格、优惠或手填内容
              </Link>
            </details>
          </>
        ) : null}
        {section === 'preview' ? (
          <div className="assistant-preview-layout">
            <section className="merchant-account-card assistant-detail-card" id="preview">
              <h2>发布前试聊</h2>
              <p className="workflow-hint">
                试聊使用当前已保存的修订 {assistant.draftRevision}，不会改变线上客服。
              </p>
              <PreviewChatForm
                merchantId={merchantId}
                assistantId={assistantId}
                draftRevision={assistant.draftRevision}
                csrfToken={csrfToken}
                available={workerAvailable && assistant.status !== 'paused'}
              />
            </section>
            <aside className="workflow-checklist" aria-label="试聊检查建议">
              <h2>建议检查</h2>
              <ul>
                <li>商品与服务范围是否准确？</li>
                <li>价格、优惠和适用条件是否一致？</li>
                <li>未知问题能否引导联系商家？</li>
              </ul>
              <Link href={merchantPath(merchantId, 'drafts', assistantId)}>
                回答不准确？返回修改资料
              </Link>
            </aside>
          </div>
        ) : null}
        {section === 'publish' ? (
          <>
            <p className="workflow-hint">
              需要找回以前发布的业务资料？
              <Link href={`${merchantPath(merchantId, 'publish', assistantId)}/history`}>
                查看发布历史与恢复草稿
              </Link>
            </p>
            <section
              className="merchant-account-card assistant-detail-card workflow-review"
              aria-label="发布内容核对"
            >
              <div className="section-heading">
                <h2>核对本次发布内容</h2>
                <Link href={merchantPath(merchantId, 'drafts', assistantId)}>修改资料</Link>
              </div>
              <p className="workflow-hint">
                以下是已保存的草稿修订 {assistant.draftRevision}。展开各项核对后再确认发布。
              </p>
              {facts.map(([label, value]) => (
                <details key={label} className="workflow-review__fact">
                  <summary>
                    {label}
                    <span>{value.length > 46 ? `${value.slice(0, 46)}…` : value}</span>
                  </summary>
                  <p>{value}</p>
                </details>
              ))}
            </section>
            <details className="workflow-disclosure workflow-readiness">
              <summary>查看资料自检提示</summary>
              <DraftReadinessPanel draft={assistant.draft} />
            </details>
            {publishPanel}
          </>
        ) : null}
        {section === 'drafts' ? (
          <AssistantWorkflowActions
            backHref={merchantPath(merchantId, 'drafts')}
            backLabel="返回客服列表"
          />
        ) : section === 'knowledge' ? (
          <AssistantWorkflowActions
            backHref={merchantPath(merchantId, 'drafts', assistantId)}
            backLabel="上一步：基础资料"
            nextHref={merchantPath(merchantId, 'preview', assistantId)}
            nextLabel="下一步：效果试聊"
          />
        ) : section === 'preview' ? (
          <AssistantWorkflowActions
            backHref={merchantPath(merchantId, 'knowledge', assistantId)}
            backLabel="上一步：知识补充"
            nextHref={merchantPath(merchantId, 'publish', assistantId)}
            nextLabel="下一步：发布分享"
          />
        ) : (
          <AssistantWorkflowActions
            backHref={merchantPath(merchantId, 'preview', assistantId)}
            backLabel="上一步：效果试聊"
          />
        )}
      </PageShell>
    </div>
  );
}
