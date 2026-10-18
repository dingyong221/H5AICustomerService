import Link from 'next/link';

import {
  AnalyticsUnavailable,
  InventoryCards,
  PeriodFilter,
  UsageCards,
  UsageTrend,
  MetricNotes,
} from './analytics-components';
import { analyticsRepository } from './analytics-data';
import {
  analyticsHref,
  beijingTime,
  parseAnalyticsQuery,
  type AnalyticsParams,
} from './analytics-query';

export async function AnalyticsOverview({ params }: { params: AnalyticsParams }) {
  let query;
  try {
    query = parseAnalyticsQuery({ from: params['from'], to: params['to'], days: params['days'] });
  } catch (error) {
    return <AnalyticsUnavailable error={error instanceof Error ? error.message : '筛选无效。'} />;
  }
  const repository = analyticsRepository();
  if (!repository) return <AnalyticsUnavailable />;
  let data = null;
  try {
    data = await repository.analytics(query.range);
  } catch {
    /* No raw database details or fake zero counts. */
  }
  if (!data) return <AnalyticsUnavailable />;
  return (
    <section className="ops-analytics" aria-label="平台经营与使用总览" id="analytics-overview">
      <div className="section-heading">
        <div>
          <p>平台数据</p>
          <h2>商家与使用总览</h2>
        </div>
        <span className="ops-muted">查询于 {beijingTime(data.generatedAt)}</span>
      </div>
      <InventoryCards data={data} />
      <PeriodFilter query={query} path="/" />
      <UsageCards usage={data.usage} usingMerchants={data.usingMerchants} />
      <UsageTrend days={data.daily} />
      <div className="ops-quick-links">
        <Link href={analyticsHref('/merchants', query, { activity: 'unused' })}>
          查看期内无咨询商家
        </Link>
        <Link href={analyticsHref('/merchants', query, { sort: 'failed' })}>
          排查失败问句较多的商家
        </Link>
        <Link href={analyticsHref('/reports', query)}>查看每日明细与导出</Link>
      </div>
      <MetricNotes />
    </section>
  );
}
