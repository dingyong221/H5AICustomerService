import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantEvaluationRun, AssistantImprovement, ImprovementDetail } from '@h5cs/domain';

const mocks = vi.hoisted(() => ({
  member: vi.fn(),
  assistants: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
  snapshot: vi.fn(),
  conversation: vi.fn(),
  notFound: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...props }, children),
}));
vi.mock('../tenant-data', () => ({
  requireMerchant: mocks.member,
  merchantAssistants: mocks.assistants,
}));
vi.mock('../account/merchant-actions', () => ({
  currentMerchantCsrfToken: async () => 'test-csrf',
}));
vi.mock('./improvement-data', () => ({ readImprovements: mocks.list }));
vi.mock('./improvement-actions', () => ({
  createImprovementAction: vi.fn(),
  updateImprovementAction: vi.fn(),
  applyImprovementAction: vi.fn(),
  evaluateImprovementAction: vi.fn(),
  reviewImprovementAction: vi.fn(),
}));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: () => ({ configured: true, config: {} }),
  MySqlAssistantImprovementRepository: class {
    detail = mocks.detail;
  },
  MySqlAssistantLifecycleRepository: class {
    findManagementSnapshot = mocks.snapshot;
  },
  MySqlMerchantConversationRepository: class {
    detail = mocks.conversation;
  },
}));
import ListPage from '../[merchantId]/improvements/page';
import DetailPage from '../[merchantId]/improvements/[improvementId]/page';
import { ImprovementSummaryPanel } from './improvement-summary';

const merchantId = 'aa'.repeat(16);
const assistantId = 'bb'.repeat(16);
const improvementId = 'cc'.repeat(16);
const sessionId = 'dd'.repeat(16);
const messageId = 'ee'.repeat(16);
const now = new Date('2026-10-17T08:00:00Z');
const block = `[FAQ-${improvementId}]\n问：偏远地区包邮吗？\n答：偏远地区需联系商家确认运费。\n[/FAQ-${improvementId}]`;
const task: AssistantImprovement = {
  id: improvementId,
  merchantId,
  assistantId,
  version: 3,
  reason: 'unclear_policy',
  question: '偏远地区包邮吗？',
  expectedAnswer: '偏远地区需联系商家确认运费。',
  notes: '核实运费条件',
  sourceSessionId: sessionId,
  sourceMessageId: messageId,
  sourceReleaseId: '11'.repeat(16),
  originalAnswer: '全场包邮。',
  appliedBlock: block,
  appliedDraftRevision: 4,
  publishedReleaseId: null,
  publishedTaskVersion: null,
  createdAt: now,
  updatedAt: now,
  state: 'needs_review',
};
const run: AssistantEvaluationRun = {
  id: 'ff'.repeat(16),
  improvementId,
  taskVersion: 3,
  draftRevision: 4,
  factsHash: 'current-facts',
  question: task.question,
  expectedAnswer: task.expectedAnswer,
  answer: '偏远地区请先联系商家确认运费。',
  errorCode: null,
  state: 'completed',
  verdict: null,
  reviewedAt: null,
  createdAt: now,
  completedAt: now,
  promptTemplateVersion: 'preview-v1',
  modelPolicyVersion: 'qwen-v1',
};
const counts = {
  needs_correction: 0,
  needs_evaluation: 0,
  needs_review: 1,
  failed: 0,
  ready_to_publish: 0,
  published: 0,
};
const detail: ImprovementDetail = {
  improvement: task,
  runs: [run],
  currentDraftRevision: 4,
  currentFactsHash: 'current-facts',
};

const listProps = (query: Record<string, string> = {}) => ({
  params: Promise.resolve({ merchantId }),
  searchParams: Promise.resolve(query),
});
const detailProps = () => ({
  params: Promise.resolve({ merchantId, improvementId }),
  searchParams: Promise.resolve({ assistant: assistantId }),
});

describe('merchant improvement page rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    mocks.notFound.mockImplementation(() => {
      throw new Error('not_found');
    });
    mocks.member.mockResolvedValue({ merchantId, merchantUserId: '22'.repeat(16) });
    mocks.assistants.mockResolvedValue([{ assistantId, displayName: '家居零售客服' }]);
    mocks.list.mockResolvedValue({ items: [task], counts, total: 1, truncated: false });
    mocks.detail.mockResolvedValue(detail);
    mocks.snapshot.mockResolvedValue({
      assistantId,
      merchantId,
      displayName: '家居零售客服',
      status: 'active',
      draftRevision: 4,
      activeReleaseId: '11'.repeat(16),
      draft: { materialsSummary: `毛巾纯棉。\n\n${block}` },
    });
    mocks.conversation.mockResolvedValue({
      conversation: { assistantId },
      messages: [{ id: messageId, role: 'visitor', content: task.question }],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders exact live counts, bounded recent list and a tenant/assistant detail link', async () => {
    mocks.list.mockResolvedValue({
      items: [task],
      counts: { ...counts, needs_correction: 50 },
      total: 51,
      truncated: true,
    });
    const html = renderToStaticMarkup(await ListPage(listProps()));
    expect(html).toContain('51');
    expect(html).toContain('列表展示最近更新的 50 项');
    expect(html).toContain(`/${merchantId}/improvements/${improvementId}?assistant=${assistantId}`);
    expect(html).toContain('不是 AI 自动推定的解决率');
    expect(html).toContain('手工新增测试或改进场景');
    expect(html).toContain('建立改进任务');
  });

  it('supports the all-assistant filter and a useful empty state instead of a 404', async () => {
    mocks.list.mockResolvedValue({
      items: [],
      counts: { ...counts, needs_review: 0 },
      total: 0,
      truncated: false,
    });
    const html = renderToStaticMarkup(await ListPage(listProps({ assistant: '' })));
    expect(html).toContain('暂时没有改进任务');
    expect(mocks.list).toHaveBeenCalledWith(merchantId, '22'.repeat(16), undefined);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('hydrates source form only from a real visitor message belonging to the selected assistant', async () => {
    const props = listProps({ assistant: assistantId, session: sessionId, message: messageId });
    const html = renderToStaticMarkup(await ListPage(props));
    expect(mocks.member).toHaveBeenCalledWith(
      merchantId,
      `/${merchantId}/improvements?assistant=${assistantId}&session=${sessionId}&message=${messageId}#create`,
    );
    expect(html).toContain('改进这条真实咨询');
    expect(html).toContain(`value="${messageId}"`);
    expect(html).toMatch(/readonly/iu);
    mocks.conversation.mockResolvedValue({
      conversation: { assistantId: '99'.repeat(16) },
      messages: [{ id: messageId, role: 'visitor', content: 'foreign message' }],
    });
    await expect(
      ListPage(listProps({ assistant: assistantId, session: sessionId, message: messageId })),
    ).rejects.toThrow('not_found');
  });

  it('shows original and actual answers, explicit human choices and separate publication steps', async () => {
    const html = renderToStaticMarkup(await DetailPage(detailProps()));
    expect(html).toContain('全场包邮。');
    expect(html).toContain('偏远地区请先联系商家确认运费。');
    expect(html).toContain('调用完成，待商家判定');
    expect(html).toContain('符合预期，判定通过');
    expect(html).toContain('不符合预期，继续改进');
    expect(html).toContain('确认资料，再发布更新');
    expect(html).toContain('不会代你查订单、退款或处理投诉');
    expect(html).toContain('复测通过不是普通发布的强制门槛');
    expect(html).toContain('即使允许发布，也不代表本任务已经验证');
  });

  it('keeps the exact old FAQ selectable and explains safe recovery after a manual edit', async () => {
    mocks.snapshot.mockResolvedValue({
      assistantId,
      merchantId,
      displayName: '家居零售客服',
      status: 'active',
      draftRevision: 4,
      activeReleaseId: '11'.repeat(16),
      draft: {
        materialsSummary: `毛巾纯棉。\n\n${block.replace(task.expectedAnswer, '手工补充：运费需按地址确认。')}`,
      },
    });
    const html = renderToStaticMarkup(await DetailPage(detailProps()));
    expect(html).toContain('<details open=""><summary>查看并复制本任务旧 FAQ 原文</summary>');
    expect(html).toContain('aria-label="本任务旧 FAQ 原文"');
    expect(html).toContain(block);
    expect(html).toContain('不需要剪贴板授权');
    expect(html).toContain('先复制保存当前草稿全文和有价值的手动补充');
    expect(html).toContain('点击“保存改进任务”');
    expect(html).toContain(`href="/${merchantId}/drafts/${assistantId}"`);
    expect(html).toContain('仅在能唯一定位本任务区块时');
    expect(html).toContain('保留本任务之外的其余资料');
    expect(html).toContain('点击“保存草稿修订”，回到本页刷新');
    expect(html).toContain('恢复旧原文不会自动应用新答案');
    expect(html).toContain('不要盲目删除、追加或覆盖，请联系平台管理员核对');
    expect(html).not.toContain('aria-label="拟写入草稿的 FAQ"');
    expect(html).toMatch(/<fieldset disabled=""><legend>应用这条 FAQ 修正/u);
    expect(html).toContain('请先把已核对的答案应用到当前草稿');
  });

  it('also retains the old FAQ when the new patch exceeds the material limit', async () => {
    mocks.snapshot.mockResolvedValue({
      assistantId,
      merchantId,
      displayName: '家居零售客服',
      status: 'active',
      draftRevision: 4,
      activeReleaseId: '11'.repeat(16),
      draft: { materialsSummary: `${'原资料'.repeat(1400)}\n\n${block}` },
    });
    const html = renderToStaticMarkup(await DetailPage(detailProps()));
    expect(html).toContain('合并后的商品或服务资料超过 4000 字');
    expect(html).toContain('查看并复制本任务旧 FAQ 原文');
    expect(html).toContain(block);
    expect(html).not.toContain('aria-label="拟写入草稿的 FAQ"');
    expect(html).not.toContain('手动调整过 FAQ，怎样安全恢复');
  });

  it('renders stale completed runs as expired and disables human approval', async () => {
    mocks.detail.mockResolvedValue({
      ...detail,
      improvement: { ...task, state: 'needs_evaluation' },
      runs: [{ ...run, draftRevision: 3 }],
    });
    const html = renderToStaticMarkup(await DetailPage(detailProps()));
    expect(html).toContain('已过期：任务、草稿或模型策略已变化');
    expect(html).toMatch(/<fieldset disabled=""><legend>人工判定本次回答/u);
    expect(html).not.toContain('本条场景已在当前草稿上通过人工验证');
  });

  it('does not confuse complaint publication with resolution or actual human connection', async () => {
    mocks.detail.mockResolvedValue({
      ...detail,
      improvement: { ...task, reason: 'complaint', publishedReleaseId: '33'.repeat(16) },
    });
    const html = renderToStaticMarkup(await DetailPage(detailProps()));
    expect(html).toContain('不代表投诉已解决或已接通人工');
    expect(html).toContain('当前线上版本已不同');
    expect(html).toContain(`/${merchantId}/conversations/${sessionId}`);
  });

  it('does not offer another human verdict after a run has already been judged', async () => {
    mocks.detail.mockResolvedValue({
      ...detail,
      improvement: { ...task, state: 'ready_to_publish' },
      runs: [{ ...run, verdict: 'pass' }],
    });
    const html = renderToStaticMarkup(await DetailPage(detailProps()));
    expect(html).toContain('商家已判定通过');
    expect(html).not.toContain('符合预期，判定通过');
    expect(html).not.toContain('不符合预期，继续改进');
  });

  it('fails closed on unavailable detail and does not render unknown summary data as zero', async () => {
    mocks.detail.mockResolvedValue(null);
    await expect(DetailPage(detailProps())).rejects.toThrow('not_found');
    mocks.list.mockResolvedValue(null);
    const html = renderToStaticMarkup(
      await ImprovementSummaryPanel({ merchantId, merchantUserId: '22'.repeat(16) }),
    );
    expect(html).toContain('未将读取失败显示为 0');
    expect(html).not.toContain('暂时没有任务');
  });
});
