import { afterEach, describe, expect, it } from 'vitest';
import {
  analyticsHref,
  beijingTime,
  completionRate,
  opsHref,
  parseAnalyticsQuery,
  responseDuration,
} from './analytics-query';

const now = new Date('2026-10-17T18:00:00Z');
describe('operations reporting filters', () => {
  it('defaults to seven Beijing days and accepts an empty optional merchant field', () => {
    expect(parseAnalyticsQuery({ merchantId: '' }, now)).toMatchObject({
      range: { from: '2026-10-12', to: '2026-10-18' },
      page: 1,
      report: 'daily',
    });
  });
  it.each([
    { from: ['2026-10-17', '2026-10-18'] },
    { from: '' },
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-19', to: '2026-10-19' },
    { days: '900' },
    { page: '0' },
    { page: '1.5' },
    { page: '1e3' },
    { page: '100001' },
    { page: ['1', '2'] },
    { status: 'all OR 1=1' },
    { sort: 'questions desc' },
    { q: 'a' },
    { q: '\u0000bad' },
    { report: '__proto__' },
    { merchantId: '../../' },
    { merchantId: 'AB'.repeat(16) },
  ])('rejects malformed query %j', (input) => {
    expect(() => parseAnalyticsQuery(input, now)).toThrow();
  });
  it('preserves the selected scope across pagination, exports and preset links', () => {
    const query = parseAnalyticsQuery(
      {
        from: '2026-10-16',
        to: '2026-10-17',
        q: '合成 商家',
        status: 'paused',
        activity: 'used',
        sort: 'failed',
        report: 'merchants',
        page: '3',
      },
      now,
    );
    const page = new URL(analyticsHref('/merchants', query, { page: 4 }), 'https://test.invalid');
    expect(Object.fromEntries(page.searchParams)).toEqual({
      from: '2026-10-16',
      to: '2026-10-17',
      q: '合成 商家',
      status: 'paused',
      activity: 'used',
      sort: 'failed',
      report: 'merchants',
      page: '4',
    });
    const preset = new URL(
      analyticsHref('/merchants', query, { from: null, to: null, days: 30 }),
      'https://test.invalid',
    );
    expect(preset.searchParams.has('page')).toBe(false);
    expect(preset.searchParams.has('from')).toBe(false);
    expect(preset.searchParams.get('days')).toBe('30');
    expect(parseAnalyticsQuery(Object.fromEntries(preset.searchParams), now).range).toEqual({
      from: '2026-09-19',
      to: '2026-10-18',
    });
  });
  it('does not display an empty completion cohort as 100 percent or zero latency', () => {
    expect(completionRate(0, 0)).toBe('—');
    expect(completionRate(3, 1)).toBe('75.0%');
    expect(responseDuration(null)).toBe('—');
    expect(responseDuration(1251)).toBe('1.25 秒');
    expect(beijingTime(null)).toBe('尚无记录');
  });
  const original = process.env['NEXT_PUBLIC_OPS_BASE_PATH'];
  afterEach(() => {
    if (original === undefined) delete process.env['NEXT_PUBLIC_OPS_BASE_PATH'];
    else process.env['NEXT_PUBLIC_OPS_BASE_PATH'] = original;
  });
  it('keeps CSV downloads under the Ops base path, never the consumer route', () => {
    delete process.env['NEXT_PUBLIC_OPS_BASE_PATH'];
    expect(opsHref('/reports/export?report=daily')).toBe('/reports/export?report=daily');
    process.env['NEXT_PUBLIC_OPS_BASE_PATH'] = '/ops';
    expect(opsHref('/reports/export?report=daily')).toBe('/ops/reports/export?report=daily');
  });
});
