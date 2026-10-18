import { describe, expect, it, vi } from 'vitest';
import type { MySqlPlatformAnalyticsRepository } from '@h5cs/database';
import { parseAnalyticsQuery } from './analytics-query';
import { prepareReportExport } from './report-export';
import { ReportExportTooLargeError } from './report-csv';

const now = new Date('2026-10-17T18:00:00Z');
describe('report exports use the same filters as the screen', () => {
  it('exports the complete filtered merchant cohort, not only the current screen page', async () => {
    const merchants = vi.fn(async () => ({ total: 0, items: [], generatedAt: now.toISOString() }));
    const query = parseAnalyticsQuery(
      { report: 'merchants', page: '3', status: 'paused', q: '合成' },
      now,
    );
    const result = await prepareReportExport(query, {
      merchants,
    } as unknown as MySqlPlatformAnalyticsRepository);
    expect(merchants).toHaveBeenCalledWith(query.range, query.filters, 1, 5001);
    expect(result.filename).toBe('h5cs-merchants-2026-10-12-2026-10-18.csv');
    expect(result.csv).toContain('"商家名称"');
    expect(result.csv.split('\r\n')).toHaveLength(2);
  });
  it('refuses an oversized export instead of silently truncating it', async () => {
    const merchants = vi.fn(async () => ({
      total: 5001,
      items: [],
      generatedAt: now.toISOString(),
    }));
    await expect(
      prepareReportExport(parseAnalyticsQuery({ report: 'merchants' }, now), {
        merchants,
      } as unknown as MySqlPlatformAnalyticsRepository),
    ).rejects.toThrow(ReportExportTooLargeError);
  });
  it('keeps single-merchant scope and explicit Beijing metadata in daily CSV', async () => {
    const id = 'ab'.repeat(16);
    const analytics = vi.fn(async () => ({
      generatedAt: now.toISOString(),
      daily: [
        {
          day: '2026-10-17',
          newMerchants: 0,
          sessions: 2,
          questions: 3,
          completed: 2,
          failed: 1,
          pending: 0,
          meanResponseMs: null,
        },
      ],
    }));
    const query = parseAnalyticsQuery({ report: 'daily', merchantId: id }, now);
    const result = await prepareReportExport(query, {
      analytics,
    } as unknown as MySqlPlatformAnalyticsRepository);
    expect(analytics).toHaveBeenCalledWith(query.range, id);
    expect(result.csv).toContain('"Asia/Shanghai"');
    expect(result.csv).toContain(`"${id}"`);
    expect(result.csv).not.toContain('null');
    expect(result.csv).not.toContain('undefined');
  });
});
