import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageShell } from '@h5cs/ui';

import {
  AnalyticsUnavailable,
  MerchantUsageTable,
  MetricNotes,
  Pagination,
  PeriodFilter,
} from '../analytics-components';
import { analyticsRepository } from '../analytics-data';
import {
  analyticsHref,
  beijingTime,
  opsHref,
  parseAnalyticsQuery,
  type AnalyticsParams,
} from '../analytics-query';
import { currentOperator, logoutOperator } from '../operator-actions';
import { ReportDownloadButton } from '../report-download-button';

export const dynamic = 'force-dynamic';

export default async function MerchantManagementPage({
  searchParams,
}: {
  searchParams: Promise<AnalyticsParams>;
}) {
  const operator = await currentOperator();
  if (!operator) redirect('/login');
  const params = await searchParams;
  let query;
  try {
    query = parseAnalyticsQuery(params);
  } catch (error) {
    return (
      <PageShell title="商家管理">
        <AnalyticsUnavailable error={error instanceof Error ? error.message : '筛选无效。'} />
      </PageShell>
    );
  }
  const repository = analyticsRepository();
  let result = null;
  if (repository) {
    try {
      result = await repository.merchants(query.range, query.filters, query.page);
    } catch {
      /* Show unavailable, never a fake empty list. */
    }
  }
  return (
    <PageShell
      title="商家管理"
      eyebrow="Merchant Operations"
      description={
        <p>查找商家、了解使用情况并处理领取与暂停状态。运营统计权限不会替代商家登录。</p>
      }
      aside={
        <form action={logoutOperator}>
          <button className="ops-logout" type="submit">
            退出登录
          </button>
        </form>
      }
    >
      <section className="ops-analytics">
        <div className="section-heading">
          <h2>商家使用与管理</h2>
          <Link className="ops-primary-link" href="/#provision">
            开通新商家
          </Link>
        </div>
        <PeriodFilter query={query} path="/merchants" merchants />
        {!result ? (
          <AnalyticsUnavailable />
        ) : (
          <>
            <div className="ops-report-toolbar">
              <p>
                符合筛选的商家共 <strong>{result.total}</strong> 个 · 查询于{' '}
                {beijingTime(result.generatedAt)}
              </p>
              <ReportDownloadButton
                secondary
                href={opsHref(analyticsHref('/reports/export', query, { report: 'merchants' }))}
              >
                导出筛选结果 CSV
              </ReportDownloadButton>
            </div>
            {result.items.length ? (
              <MerchantUsageTable rows={result.items} query={query} />
            ) : (
              <p className="ops-empty">
                {result.total
                  ? '当前页没有记录，请返回第一页。'
                  : '没有符合当前筛选的商家。可调整条件或开通新商家。'}
              </p>
            )}
            <Pagination query={query} path="/merchants" total={result.total} />
          </>
        )}
        <MetricNotes />
      </section>
    </PageShell>
  );
}
