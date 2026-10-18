import {
  platformReportRange,
  type PlatformMerchantFilters,
  type PlatformReportRange,
} from '@h5cs/database';

export type AnalyticsParams = Readonly<Record<string, string | string[] | undefined>>;
export const REPORT_NAMES = {
  daily: '每日使用',
  merchants: '商家使用',
  assistants: '客服使用',
  quality: '改进与复测',
  errors: '异常分布',
} as const;
export type ReportKind = keyof typeof REPORT_NAMES;
export type AnalyticsQuery = Readonly<{
  range: PlatformReportRange;
  filters: PlatformMerchantFilters;
  page: number;
  report: ReportKind;
  today: string;
  merchantId?: string;
}>;

export function parseAnalyticsQuery(params: AnalyticsParams, now = new Date()): AnalyticsQuery {
  const get = (key: string): string | undefined => {
    const value = params[key];
    if (Array.isArray(value)) throw new Error('同一个筛选项不能重复填写。');
    return value;
  };
  let range: PlatformReportRange;
  try {
    const from = get('from'),
      to = get('to'),
      rawDays = get('days');
    if (
      (rawDays !== undefined && !['1', '7', '30', '90'].includes(rawDays)) ||
      from === '' ||
      to === ''
    )
      throw new Error();
    range = platformReportRange(
      {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(rawDays ? { days: Number(rawDays) } : {}),
      },
      now,
    );
  } catch {
    throw new Error('请选择完整、有效的北京时间日期，结束日不能晚于今天，最多查询 93 天。');
  }
  const search = get('q')?.trim() ?? '';
  if (
    search !== '' &&
    (search.length < 2 || search.length > 100 || /[\u0000-\u001f\u007f]/u.test(search))
  )
    throw new Error('商家名称或完整 ID 请填写 2–100 个可显示字符。');
  const status = get('status') ?? 'all',
    activity = get('activity') ?? 'all',
    sort = get('sort') ?? 'recent';
  if (
    !['all', 'pending_owner', 'active', 'paused'].includes(status) ||
    !['all', 'used', 'unused'].includes(activity) ||
    !['recent', 'questions', 'sessions', 'failed'].includes(sort)
  )
    throw new Error('商家筛选项无效，请重新选择。');
  const rawPage = get('page') ?? '1';
  if (!/^[1-9]\d{0,5}$/u.test(rawPage) || Number(rawPage) > 100_000)
    throw new Error('页码无效，请从第一页重新查询。');
  const report = get('report') ?? 'daily';
  if (!Object.hasOwn(REPORT_NAMES, report)) throw new Error('请选择有效的报表类型。');
  const rawMerchantId = get('merchantId');
  const merchantId = rawMerchantId === '' ? undefined : rawMerchantId;
  if (merchantId !== undefined && !/^[0-9a-f]{32}$/u.test(merchantId))
    throw new Error('商家编号必须是完整的 32 位小写 ID。');
  return {
    range,
    filters: {
      search,
      status: status as NonNullable<PlatformMerchantFilters['status']>,
      activity: activity as NonNullable<PlatformMerchantFilters['activity']>,
      sort: sort as NonNullable<PlatformMerchantFilters['sort']>,
      ...(merchantId ? { merchantId } : {}),
    },
    page: Number(rawPage),
    report: report as ReportKind,
    today: platformReportRange({ days: 1 }, now).to,
    ...(merchantId ? { merchantId } : {}),
  };
}

export function analyticsHref(
  path: string,
  query: AnalyticsQuery,
  changes: Record<string, string | number | null> = {},
): string {
  const values = new URLSearchParams({ from: query.range.from, to: query.range.to });
  if (query.filters.search) values.set('q', query.filters.search);
  if (query.filters.status && query.filters.status !== 'all')
    values.set('status', query.filters.status);
  if (query.filters.activity && query.filters.activity !== 'all')
    values.set('activity', query.filters.activity);
  if (query.filters.sort && query.filters.sort !== 'recent') values.set('sort', query.filters.sort);
  if (query.merchantId) values.set('merchantId', query.merchantId);
  if (query.report !== 'daily') values.set('report', query.report);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) values.delete(key);
    else values.set(key, String(value));
  }
  return `${path}?${values.toString()}`;
}

export const merchantStatusLabel = (status: string): string => {
  const labels: Record<string, string> = {
    pending_owner: '等待领取',
    active: '已启用',
    paused: '已暂停',
  };
  return Object.hasOwn(labels, status) ? labels[status]! : '其他状态';
};
export { opsHref } from './ops-path';
export const responseDuration = (ms: number | null): string =>
  ms === null ? '—' : `${(ms / 1000).toFixed(2)} 秒`;
export const completionRate = (completed: number, failed: number): string =>
  completed + failed === 0 ? '—' : `${((completed / (completed + failed)) * 100).toFixed(1)}%`;
export const beijingTime = (at: string | null): string =>
  at === null
    ? '尚无记录'
    : new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
