import {
  PLATFORM_REPORT_EXPORT_LIMIT,
  type MySqlPlatformAnalyticsRepository,
} from '@h5cs/database';

import { merchantStatusLabel, type AnalyticsQuery } from './analytics-query';
import { reportCsv, ReportExportTooLargeError } from './report-csv';

type Cell = string | number | null;

export async function prepareReportExport(
  query: AnalyticsQuery,
  repository: MySqlPlatformAnalyticsRepository,
): Promise<{ csv: string; filename: string }> {
  let headers: string[], rows: readonly (readonly Cell[])[], generatedAt: string;
  const checkTotal = (total: number) => {
    if (total > PLATFORM_REPORT_EXPORT_LIMIT)
      throw new ReportExportTooLargeError(
        '结果超过 5,000 条，请按商家编号、名称或状态缩小筛选后再导出；未生成截断文件。',
      );
  };
  if (query.report === 'merchants') {
    const result = await repository.merchants(
      query.range,
      query.filters,
      1,
      PLATFORM_REPORT_EXPORT_LIMIT + 1,
    );
    checkTotal(result.total);
    generatedAt = result.generatedAt;
    headers = [
      '商家ID',
      '商家名称',
      '当前状态',
      '开通时间UTC',
      '客服总数',
      '已发布客服',
      '新建会话',
      '消费者问句',
      '完成问句',
      '失败问句',
      '未终结问句',
      '平均处理毫秒',
      '最近消费者问句UTC',
    ];
    rows = result.items.map((item) => [
      item.id,
      item.name,
      merchantStatusLabel(item.status),
      item.createdAt,
      item.assistants,
      item.publishedAssistants,
      item.sessions,
      item.questions,
      item.completed,
      item.failed,
      item.pending,
      item.meanResponseMs,
      item.lastConsultationAt,
    ]);
  } else if (query.report === 'assistants') {
    const result = await repository.assistants(
      query.range,
      query.merchantId,
      1,
      PLATFORM_REPORT_EXPORT_LIMIT + 1,
    );
    checkTotal(result.total);
    generatedAt = result.generatedAt;
    headers = [
      '客服ID',
      '客服名称',
      '商家ID',
      '商家名称',
      '客服状态',
      '当前发布ID',
      '新建会话',
      '消费者问句',
      '完成问句',
      '失败问句',
      '未终结问句',
      '平均处理毫秒',
    ];
    rows = result.items.map((item) => [
      item.id,
      item.displayName,
      item.merchantId,
      item.merchantName,
      item.status,
      item.releaseId,
      item.sessions,
      item.questions,
      item.completed,
      item.failed,
      item.pending,
      item.meanResponseMs,
    ]);
  } else {
    const data = await repository.analytics(query.range, query.merchantId);
    generatedAt = data.generatedAt;
    if (query.report === 'daily') {
      headers = [
        '北京时间日期',
        '新商家',
        '新建会话',
        '消费者问句',
        '完成问句',
        '失败问句',
        '未终结问句',
        '平均处理毫秒',
      ];
      rows = data.daily.map((item) => [
        item.day,
        item.newMerchants,
        item.sessions,
        item.questions,
        item.completed,
        item.failed,
        item.pending,
        item.meanResponseMs,
      ]);
    } else if (query.report === 'quality') {
      const quality = data.quality;
      headers = [
        '新建改进任务',
        '当前任务版本已发布',
        '复测运行次数',
        '复测完成',
        '复测失败',
        '复测待完成',
        '商家评审通过',
        '商家评审不通过',
        '完成待评审',
      ];
      rows = [
        [
          quality.improvements,
          quality.publishedImprovements,
          quality.evaluations,
          quality.evaluationCompleted,
          quality.evaluationFailed,
          quality.evaluationPending,
          quality.verdictPass,
          quality.verdictFail,
          quality.unreviewed,
        ],
      ];
    } else {
      checkTotal(data.errors.length);
      headers = ['来源', '类型', '错误码', '当前失败记录数'];
      rows = data.errors.map((item) => [
        item.source === 'conversation' ? '消费者问句' : '后台任务',
        item.type,
        item.code,
        item.total,
      ]);
    }
  }
  const context = [
    query.range.from,
    query.range.to,
    'Asia/Shanghai',
    generatedAt,
    query.merchantId ?? '全平台',
  ];
  return {
    filename: `h5cs-${query.report}-${query.range.from}-${query.range.to}.csv`,
    csv: reportCsv(
      ['统计开始日', '统计结束日', '统计时区', '查询时间UTC', '商家范围', ...headers],
      rows.map((row) => [...context, ...row]),
    ),
  };
}
