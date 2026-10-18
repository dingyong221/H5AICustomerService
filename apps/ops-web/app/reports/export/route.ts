import { currentOperator } from '../../operator-actions';
import { analyticsRepository } from '../../analytics-data';
import { parseAnalyticsQuery, type AnalyticsParams } from '../../analytics-query';
import { prepareReportExport } from '../../report-export';
import { ReportExportTooLargeError } from '../../report-csv';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(request: Request): Promise<Response> {
  if (!(await currentOperator()))
    return Response.json({ error: '请先登录运营后台。' }, { status: 401, headers });
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    return Response.json({ error: '请从运营后台发起下载。' }, { status: 403, headers });
  const url = new URL(request.url);
  const params: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    params[key] = values.length === 1 ? values[0]! : values;
  }
  let query;
  try {
    query = parseAnalyticsQuery(params satisfies AnalyticsParams);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '筛选无效。' },
      { status: 400, headers },
    );
  }
  const repository = analyticsRepository();
  if (!repository)
    return Response.json({ error: '统计暂不可用，未生成报表。' }, { status: 503, headers });
  try {
    const result = await prepareReportExport(query, repository);
    return new Response(result.csv, {
      headers: {
        ...headers,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${result.filename}"`,
      },
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ReportExportTooLargeError
            ? error.message
            : '统计查询失败，未生成报表，请稍后重试。',
      },
      { status: error instanceof ReportExportTooLargeError ? 413 : 503, headers },
    );
  }
}
