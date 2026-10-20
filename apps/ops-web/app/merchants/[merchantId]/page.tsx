import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { PageShell } from '@h5cs/ui';

import {
  AnalyticsUnavailable,
  AssistantUsageTable,
  DailyUsageTable,
  MetricNotes,
  PeriodFilter,
  QualitySummary,
  UsageCards,
} from '../../analytics-components';
import { analyticsRepository } from '../../analytics-data';
import {
  analyticsHref,
  beijingTime,
  merchantStatusLabel,
  parseAnalyticsQuery,
  type AnalyticsParams,
} from '../../analytics-query';
import { managementBaseUrl, merchantWorkspaceUrl } from '../../management-url';
import { ManagementLink } from '../../management-link';
import { MerchantStatusForm } from '../../merchant-status-form';
import { currentOperator } from '../../operator-actions';
import { ReissueInvitationForm } from '../../reissue-invitation-form';
import { MerchantAccounts } from '../../merchant-accounts';

export const dynamic = 'force-dynamic';

export default async function MerchantUsageDetail({
  params,
  searchParams,
}: {
  params: Promise<{ merchantId: string }>;
  searchParams: Promise<AnalyticsParams>;
}) {
  if (!(await currentOperator())) redirect('/login');
  const { merchantId } = await params;
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) notFound();
  let query;
  try {
    query = parseAnalyticsQuery({ ...(await searchParams), merchantId });
  } catch (error) {
    return (
      <PageShell title="商家详情">
        <AnalyticsUnavailable error={error instanceof Error ? error.message : '筛选无效。'} />
      </PageShell>
    );
  }
  const repository = analyticsRepository();
  let result = null;
  if (repository) {
    try {
      const merchant = await repository.merchants(query.range, { merchantId }, 1, 1);
      if (merchant.items[0]) {
        const [analytics, assistants] = await Promise.all([
          repository.analytics(query.range, merchantId),
          repository.assistants(query.range, merchantId, 1, 50),
        ]);
        result = { merchant: merchant.items[0], analytics, assistants };
      } else {
        result = 'missing' as const;
      }
    } catch {
      /* Do not expose database errors or treat them as not found. */
    }
  }
  if (result === 'missing') notFound();
  if (!result)
    return (
      <PageShell title="商家详情">
        <AnalyticsUnavailable />
      </PageShell>
    );
  const { merchant, analytics, assistants } = result;
  const managementBase = managementBaseUrl(process.env['MANAGEMENT_CONSOLE_URL']);
  return (
    <PageShell
      title={merchant.name}
      eyebrow="Merchant Detail"
      description={
        <p>
          商家 ID：<code>{merchantId}</code> · 开通于 {beijingTime(merchant.createdAt)}
        </p>
      }
      aside={<Link href="/merchants">返回商家管理</Link>}
    >
      <section className="ops-analytics">
        <div className="ops-merchant-detail-header">
          <div>
            <span className="ops-state">{merchantStatusLabel(merchant.status)}</span>
            <p>
              客服 {merchant.assistants} 个 · 已发布 {merchant.publishedAssistants} 个
            </p>
            <p>最近消费者问句：{beijingTime(merchant.lastConsultationAt)}</p>
          </div>
          <div>
            {merchant.status === 'active' && managementBase ? (
              <ManagementLink href={merchantWorkspaceUrl(managementBase, merchantId)} />
            ) : null}
            <p className="ops-muted">商家后台仍需商家账号登录；不会以运营身份代登。</p>
          </div>
        </div>
        <PeriodFilter query={query} path={`/merchants/${merchantId}`} />
        <UsageCards usage={analytics.usage} />
        <div className="ops-report-toolbar">
          <p>期间使用明细 · 查询于 {beijingTime(analytics.generatedAt)}</p>
          <Link href={analyticsHref('/reports', query)}>查看此商家报表与导出</Link>
        </div>
        <DailyUsageTable days={analytics.daily} />
        <h2>客服使用情况</h2>
        {assistants.items.length ? (
          <AssistantUsageTable rows={assistants.items} query={query} />
        ) : (
          <p className="ops-empty">该商家尚未创建客服。</p>
        )}
        {assistants.total > 50 ? (
          <p>
            这里只展示用量最多的 50 个客服；
            <Link href={analyticsHref('/reports', query, { report: 'assistants' })}>
              查看全部客服分页明细
            </Link>
            。
          </p>
        ) : null}
        <h2>改进与复测</h2>
        <QualitySummary data={analytics.quality} />
        <section className="ops-status-panel" aria-label="商家状态管理">
          <h2>商家状态管理</h2>
          {merchant.status === 'pending_owner' ? (
            <>
              <p>等待负责人领取。重新签发会立即使旧领取链接失效。</p>
              <ReissueInvitationForm merchantId={merchantId} />
            </>
          ) : null}
          {merchant.status === 'active' || merchant.status === 'paused' ? (
            <details key={merchant.status}>
              <summary>{merchant.status === 'active' ? '暂停此商家' : '恢复此商家'}</summary>
              <MerchantStatusForm
                key={merchant.status}
                merchantId={merchantId}
                paused={merchant.status === 'active'}
              />
            </details>
          ) : null}
          <p className="ops-muted">
            暂停／恢复沿用现有服务端权限、事务与审计，不删除商家、客服和历史记录。
          </p>
        </section>
        <MerchantAccounts merchantId={merchantId} />
        <MetricNotes />
      </section>
    </PageShell>
  );
}
