import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageShell } from '@h5cs/ui';
import type {
  PlatformAnalytics,
  PlatformAssistantUsage,
  PlatformMerchantUsage,
  PlatformUsagePage,
} from '@h5cs/database';

import {
  AnalyticsUnavailable,
  AssistantUsageTable,
  DailyUsageTable,
  ErrorDistribution,
  MerchantUsageTable,
  MetricNotes,
  Pagination,
  PeriodFilter,
  QualitySummary,
  UsageCards,
  UsageTrend,
} from '../analytics-components';
import { analyticsRepository } from '../analytics-data';
import {
  analyticsHref,
  beijingTime,
  opsHref,
  parseAnalyticsQuery,
  REPORT_NAMES,
  type AnalyticsParams,
} from '../analytics-query';
import { currentOperator } from '../operator-actions';
import { ReportDownloadButton } from '../report-download-button';

export const dynamic = 'force-dynamic';

export default async function PlatformReportsPage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsParams>;
}) {
  if (!(await currentOperator())) redirect('/login');
  let query;
  try {
    query = parseAnalyticsQuery(await searchParams);
  } catch (error) {
    return (
      <PageShell title="数据报表">
        <AnalyticsUnavailable error={error instanceof Error ? error.message : '筛选无效。'} />
      </PageShell>
    );
  }
  const repository = analyticsRepository();
  let analytics: PlatformAnalytics | null = null,
    merchants: PlatformUsagePage<PlatformMerchantUsage> | null = null,
    assistants: PlatformUsagePage<PlatformAssistantUsage> | null = null;
  if (repository) {
    try {
      if (query.report === 'merchants')
        merchants = await repository.merchants(query.range, query.filters, query.page);
      else if (query.report === 'assistants')
        assistants = await repository.assistants(query.range, query.merchantId, query.page);
      else analytics = await repository.analytics(query.range, query.merchantId);
    } catch {
      /* Unavailable is not zero usage. */
    }
  }
  const generatedAt = analytics?.generatedAt ?? merchants?.generatedAt ?? assistants?.generatedAt;
  return (
    <PageShell
      title="数据报表"
      eyebrow="Platform Reports"
      description={
        <p>按日期和商家查看真实使用数据。支持 CSV 导出，不包含消费者对话正文或登录凭据。</p>
      }
      aside={<Link href="/merchants">管理商家</Link>}
    >
      <section className="ops-analytics">
        <nav className="ops-report-tabs" aria-label="报表类型">
          {Object.entries(REPORT_NAMES).map(([key, label]) => (
            <Link
              key={key}
              aria-current={key === query.report ? 'page' : undefined}
              href={analyticsHref('/reports', query, {
                report: key,
                q: null,
                status: null,
                activity: null,
                sort: null,
              })}
            >
              {label}
            </Link>
          ))}
        </nav>
        <PeriodFilter
          query={query}
          path="/reports"
          report
          merchants={query.report === 'merchants'}
        />
        <div className="ops-report-toolbar">
          <div>
            <h2>{REPORT_NAMES[query.report]}</h2>
            <p>
              {query.merchantId ? `仅商家 ${query.merchantId}` : '全平台'} · {query.range.from} 至{' '}
              {query.range.to}
              {generatedAt ? ` · 查询于 ${beijingTime(generatedAt)}` : ''}
            </p>
          </div>
          {generatedAt ? (
            <ReportDownloadButton href={opsHref(analyticsHref('/reports/export', query))}>
              导出本报表 CSV
            </ReportDownloadButton>
          ) : null}
        </div>
        {!generatedAt ? <AnalyticsUnavailable /> : null}
        {analytics && query.report === 'daily' ? (
          <>
            <UsageCards usage={analytics.usage} usingMerchants={analytics.usingMerchants} />
            <UsageTrend days={analytics.daily} />
            <DailyUsageTable days={analytics.daily} />
          </>
        ) : null}
        {analytics && query.report === 'quality' ? (
          <QualitySummary data={analytics.quality} />
        ) : null}
        {analytics && query.report === 'errors' ? <ErrorDistribution data={analytics} /> : null}
        {merchants ? (
          <>
            {merchants.items.length ? (
              <MerchantUsageTable rows={merchants.items} query={query} />
            ) : (
              <p className="ops-empty">当前页没有符合条件的商家。</p>
            )}
            <Pagination query={query} path="/reports" total={merchants.total} />
          </>
        ) : null}
        {assistants ? (
          <>
            {assistants.items.length ? (
              <AssistantUsageTable rows={assistants.items} query={query} />
            ) : (
              <p className="ops-empty">当前页没有客服记录。</p>
            )}
            <Pagination query={query} path="/reports" total={assistants.total} />
          </>
        ) : null}
        <MetricNotes />
      </section>
    </PageShell>
  );
}
