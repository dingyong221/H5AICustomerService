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
import { ImprovementSummaryPanel } from './improvements/improvement-summary';
import { MaterialManager } from './knowledge/material-manager';

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
          : '当前尚未发布。勾选下方确认并提交，会实际发布客服并生成可分享的固定消费者链接。'}
        上传材料、保存草稿或历史资料确认本身不代表已经发布。
      </p>
      <p>仅发布上方已保存的草稿修订。尚未保存的编辑内容不会发布，请先保存草稿。</p>
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
  return (
    <PageShell
      aside={<Link href={merchantPath(merchantId)}>返回商家工作台</Link>}
      description={
        <p>核对真实业务资料后，勾选“确认资料并发布”，即可实际发布并获得固定消费者链接。</p>
      }
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
        {section !== 'drafts' ? (
          <>
            {' '}
            · <a href="#release">前往确认资料并发布</a>
          </>
        ) : null}
      </p>
      {assistant.activeReleaseId ? (
        <section
          aria-labelledby="consumer-link-title"
          className="merchant-account-card assistant-detail-card"
          id="consumer-link"
          tabIndex={-1}
        >
          <h2 id="consumer-link-title">固定消费者链接</h2>
          <p>此客服已有实际发布版本。消费者使用同一地址，发布新版或编辑草稿不会更换链接。</p>
          {persistedPublicUrl && sharingOrigin ? (
            <ShareAssistantLink expectedOrigin={sharingOrigin} href={persistedPublicUrl} />
          ) : (
            <p role="alert">已发布版本保留，但消费者链接的正式域名配置暂不可用，请联系运营核对。</p>
          )}
          {!publishReady ? (
            <p role="status">固定地址仍保留，当前服务暂不可用，建议恢复后再分享。{publishReason}</p>
          ) : (
            <p>可复制上方链接或下载二维码发给消费者；请勿发送商家后台管理地址。</p>
          )}
        </section>
      ) : null}
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
      {section === 'knowledge' ? (
        <MaterialManager
          merchantId={merchantId}
          assistantId={assistantId}
          csrfToken={csrfToken}
          revision={assistant.draftRevision}
          materials={materials}
        />
      ) : null}
      {section === 'knowledge' ? publishPanel : null}
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
      {section === 'publish' && (
        <section className="merchant-account-card assistant-detail-card" id="preview">
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
      {section === 'publish' ? publishPanel : null}
      <ImprovementSummaryPanel
        merchantId={merchantId}
        merchantUserId={session.merchantUserId}
        assistantId={assistantId}
      />
    </PageShell>
  );
}
