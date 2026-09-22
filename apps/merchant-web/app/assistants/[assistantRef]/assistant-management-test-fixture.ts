export const snapshotFixture = {
  assistantRef: 'assistant_01',
  currentRelease: null,
  draft: {
    assistantName: '小蓝客服',
    businessScope: '空调清洗服务咨询',
    industry: { code: 'home_service', label: '家政与本地生活' },
    insufficientInfoMessage: '当前资料不足，请联系商家确认。',
    materialsSummary: '1 条商家手工 FAQ 已可用于发布',
    pricingSummary: '单台挂机清洗起步价 100 元',
    promotionSummary: '暂无已确认优惠',
    revision: 3,
    updatedAt: '2026-09-21T08:00:00.000Z',
    welcomeMessage: '你好，我是小蓝 AI 客服。',
  },
  etag: '"draft-3"',
  publication: null,
  publishCheck: {
    items: [
      { code: 'draft_complete', level: 'passed', message: '基础信息完整' },
      { code: 'knowledge_ready', level: 'passed', message: '至少一条 FAQ 可用' },
    ],
    state: 'ready',
  },
} as const;
