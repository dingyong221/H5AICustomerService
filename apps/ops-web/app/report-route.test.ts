import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ operator: vi.fn(), repository: vi.fn(), export: vi.fn() }));
vi.mock('./operator-actions', () => ({ currentOperator: mocks.operator }));
vi.mock('./analytics-data', () => ({ analyticsRepository: mocks.repository }));
vi.mock('./report-export', () => ({ prepareReportExport: mocks.export }));
import { GET } from './reports/export/route';
import { ReportExportTooLargeError } from './report-csv';

describe('authenticated report download boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.operator.mockResolvedValue('operator');
    mocks.repository.mockReturnValue({});
    mocks.export.mockResolvedValue({ csv: '\ufeff"日期"\r\n', filename: 'h5cs-daily.csv' });
  });
  it('does not query or export for an unauthenticated visitor', async () => {
    mocks.operator.mockResolvedValue(null);
    const result = await GET(new Request('https://test.invalid/ops/reports/export'));
    expect(result.status).toBe(401);
    expect(mocks.repository).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
  });
  it('refuses cross-site downloads even for a signed-in operator', async () => {
    const result = await GET(
      new Request('https://test.invalid/ops/reports/export', {
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
    );
    expect(result.status).toBe(403);
    expect(mocks.repository).not.toHaveBeenCalled();
  });
  it('refuses duplicate and invalid query parameters before querying data', async () => {
    expect(
      (await GET(new Request('https://test.invalid/ops/reports/export?page=1&page=2'))).status,
    ).toBe(400);
    expect(mocks.repository).not.toHaveBeenCalled();
  });
  it('sends a private non-cacheable attachment with no content sniffing', async () => {
    const result = await GET(new Request('https://test.invalid/ops/reports/export'));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.headers.get('vary')).toBe('Cookie');
    expect(result.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(result.headers.get('content-disposition')).toContain('attachment;');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('never leaks database exceptions in an error response or emits a partial file', async () => {
    mocks.export.mockRejectedValue(new Error('sensitive internal detail'));
    const result = await GET(new Request('https://test.invalid/ops/reports/export'));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('sensitive');
    expect(result.headers.has('content-disposition')).toBe(false);
  });
  it('explains oversized exports without downloading a truncated report', async () => {
    mocks.export.mockRejectedValue(new ReportExportTooLargeError('请缩小筛选。'));
    const result = await GET(new Request('https://test.invalid/ops/reports/export'));
    expect(result.status).toBe(413);
    expect(result.headers.has('content-disposition')).toBe(false);
  });

  it('returns unavailable instead of a blank CSV if no database is configured', async () => {
    mocks.repository.mockReturnValue(null);
    const result = await GET(new Request('https://test.invalid/ops/reports/export'));
    expect(result.status).toBe(503);
    expect(mocks.export).not.toHaveBeenCalled();
  });
});
