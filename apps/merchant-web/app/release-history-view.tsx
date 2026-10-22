import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { loadDatabaseConfig, MySqlAssistantLifecycleRepository } from '@h5cs/database';
import { toAssistantId, toMerchantId, toMerchantUserId, toReleaseId } from '@h5cs/domain';
import { PageShell, StatusBadge } from '@h5cs/ui';
import { currentMerchant, currentMerchantCsrfToken } from './account/merchant-actions';
import { merchantPath } from './tenant-paths';
import { ReleaseRestoreForm } from './workspace/release-restore-form';

export const dynamic = 'force-dynamic';
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
const time = (value: Date) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);

export async function ReleaseHistoryView({
  merchantId,
  assistantId,
  releaseId,
  before,
}: {
  merchantId: string;
  assistantId: string;
  releaseId?: string;
  before?: unknown;
}) {
  if (
    !hex(merchantId) ||
    !hex(assistantId) ||
    (releaseId !== undefined && !hex(releaseId)) ||
    (before !== undefined && (typeof before !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(before)))
  )
    notFound();
  const base = `${merchantPath(merchantId, 'publish', assistantId)}/history`;
  const currentPath = releaseId
    ? `${base}/${releaseId}`
    : before
      ? `${base}?before=${before as string}`
      : base;
  const session = await currentMerchant(merchantId);
  if (!session)
    redirect(
      `/console/account/login?merchant=${merchantId}&next=${encodeURIComponent(currentPath)}`,
    );
  const database = loadDatabaseConfig();
  if (!database.configured)
    return <p role="alert">历史版本暂不可用，数据库尚未配置。现有资料未改变。</p>;
  const repository = new MySqlAssistantLifecycleRepository(database.config);
  const scope = {
    merchantId: toMerchantId(merchantId),
    assistantId: toAssistantId(assistantId),
    merchantUserId: toMerchantUserId(session.merchantUserId),
  };
  let assistant, page, snapshot;
  try {
    assistant = await repository.findManagementSnapshot(scope.merchantId, scope.assistantId);
    if (assistant) {
      if (releaseId)
        snapshot = await repository.findReleaseHistorySnapshot({
          ...scope,
          releaseId: toReleaseId(releaseId),
        });
      else
        page = await repository.listReleaseHistory({
          ...scope,
          ...(before ? { beforeReleaseNo: Number(before) } : {}),
        });
    }
  } catch {
    return <p role="alert">发布历史暂不可用，请稍后刷新。当前草稿和消费者版本未改变。</p>;
  }
  if (!assistant || (releaseId && !snapshot)) notFound();
  const csrfToken = snapshot?.canRestore ? await currentMerchantCsrfToken() : '';
  const facts: readonly (readonly [string, string])[] = snapshot
    ? [
        ['细分行业', snapshot.draft.industry],
        ['业务范围', snapshot.draft.businessScope],
        ['商品或服务资料', snapshot.draft.materialsSummary],
        ['价格与条件', snapshot.draft.pricingSummary],
        ['优惠与售卖策略', snapshot.draft.promotionSummary],
        ['欢迎语', snapshot.draft.welcomeMessage],
        ['资料不足时的回复', snapshot.draft.insufficientInfoMessage],
        ['人工联系说明', snapshot.draft.humanContact || '尚未提供。'],
      ]
    : [];
  return (
    <div className="assistant-workflow-layout release-history-view">
      <PageShell
        title={snapshot ? `第 ${snapshot.releaseNo} 版业务资料` : '发布历史'}
        eyebrow="AI 客服 / 发布记录"
        description={<p>查看已发布的业务资料。恢复后先核对草稿和试聊，再决定是否发布。</p>}
        aside={
          <Link href={snapshot ? base : merchantPath(merchantId, 'publish', assistantId)}>
            {snapshot ? '返回发布历史' : '返回发布分享'}
          </Link>
        }
      >
        <div className="assistant-workflow-context">
          <p>
            当前客服：<strong>{assistant.displayName}</strong>
          </p>
          <span>当前草稿修订 {assistant.draftRevision}</span>
        </div>
        {snapshot ? (
          <>
            <section
              className="merchant-account-card assistant-detail-card"
              aria-label="历史版本内容"
            >
              <div className="section-heading">
                <h2>
                  第 {snapshot.releaseNo} 版 · 发布于 {time(snapshot.activatedAt)}
                </h2>
                <StatusBadge tone={snapshot.isCurrent ? 'success' : 'warning'}>
                  {snapshot.isCurrent ? '当前发布版本' : '历史发布版本'}
                </StatusBadge>
              </div>
              <p>
                当时的草稿修订 {snapshot.draftRevision}
                。这些已发布内容保留不变；下方恢复操作只创建新的待核对草稿。
              </p>
              {facts.map(([label, value]) => (
                <details className="workflow-review__fact" key={label}>
                  <summary>
                    {label}
                    <span>{value.length > 46 ? `${value.slice(0, 46)}…` : value}</span>
                  </summary>
                  <p>{value}</p>
                </details>
              ))}
            </section>
            <section
              className="merchant-account-card assistant-detail-card"
              aria-label="恢复历史业务资料"
            >
              <h2>恢复到草稿，不直接上线</h2>
              {snapshot.canRestore ? (
                <ReleaseRestoreForm
                  key={snapshot.releaseId}
                  merchantId={merchantId}
                  assistantId={assistantId}
                  releaseId={snapshot.releaseId}
                  releaseNo={snapshot.releaseNo}
                  draftRevision={assistant.draftRevision}
                  csrfToken={csrfToken}
                />
              ) : (
                <p>当前账号仅可查看。恢复资料需要商家负责人、管理员或编辑权限。</p>
              )}
            </section>
          </>
        ) : (
          <section
            className="merchant-account-card assistant-detail-card"
            aria-label="已发布版本列表"
          >
            <h2>已发布版本</h2>
            {!page?.items.length ? (
              before ? (
                <p>
                  没有更早的发布版本。<Link href={base}>返回最新记录</Link>
                </p>
              ) : (
                <p>暂无发布历史。成功发布后，版本会在这里保留。</p>
              )
            ) : (
              <ol className="release-history-list">
                {page.items.map((item) => (
                  <li key={item.releaseId}>
                    <div>
                      <strong>第 {item.releaseNo} 版</strong> · {time(item.activatedAt)}
                      <p>
                        草稿修订 {item.draftRevision} ·{' '}
                        {item.isCurrent ? '当前发布版本' : '历史发布版本'}
                      </p>
                    </div>
                    <Link href={`${base}/${item.releaseId}`}>查看第 {item.releaseNo} 版</Link>
                  </li>
                ))}
              </ol>
            )}
            {page?.nextBeforeReleaseNo ? (
              <Link href={`${base}?before=${page.nextBeforeReleaseNo}`}>查看更早版本</Link>
            ) : null}
          </section>
        )}
      </PageShell>
    </div>
  );
}
