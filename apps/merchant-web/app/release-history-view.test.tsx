import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  config: vi.fn(),
  assistant: vi.fn(),
  list: vi.fn(),
  source: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw Error('not_found');
  },
  redirect: (path: string) => {
    throw Error('redirect:' + path);
  },
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { href: string; children: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock('@h5cs/ui', () => ({
  PageShell: ({
    children,
    title,
    aside,
  }: {
    children: React.ReactNode;
    title: string;
    aside: React.ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {aside}
      {children}
    </main>
  ),
  StatusBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: mocks.config,
  MySqlAssistantLifecycleRepository: class {
    findManagementSnapshot = mocks.assistant;
    listReleaseHistory = mocks.list;
    findReleaseHistorySnapshot = mocks.source;
  },
}));
vi.mock('./account/merchant-actions', () => ({
  currentMerchant: mocks.current,
  currentMerchantCsrfToken: async () => 'test-csrf',
}));
vi.mock('./workspace/release-restore-form', () => ({
  ReleaseRestoreForm: ({ releaseId }: { releaseId: string }) => (
    <form data-restore-source={releaseId} />
  ),
}));
import { ReleaseHistoryView } from './release-history-view';
const merchantId = 'aa'.repeat(16),
  assistantId = 'bb'.repeat(16),
  releaseId = 'cc'.repeat(16),
  userId = 'dd'.repeat(16);
const scope = { merchantId, assistantId };
const item = {
  releaseId,
  releaseNo: 1,
  draftRevision: 2,
  isCurrent: false,
  canRestore: true,
  status: 'retired',
  createdAt: new Date('2026-10-22T12:00:00Z'),
  activatedAt: new Date('2026-10-22T12:00:00Z'),
};
const draft = {
  industry: '零售',
  businessScope: '商品咨询',
  materialsSummary: '原版商品价格29元',
  pricingSummary: '新疆运费15元',
  promotionSummary: '不能叠加优惠',
  welcomeMessage: '您好，我是AI。',
  insufficientInfoMessage: '需确认',
};
describe('published history drill-down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    mocks.current.mockResolvedValue({ merchantUserId: userId });
    mocks.config.mockReturnValue({ configured: true, config: {} });
    mocks.assistant.mockResolvedValue({ displayName: '测试客服', draftRevision: 4 });
    mocks.list.mockResolvedValue({ items: [item], nextBeforeReleaseNo: 1 });
    mocks.source.mockResolvedValue({ ...item, draft });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('renders a separate metadata list and bounded older-page link rather than every snapshot body', async () => {
    const html = renderToStaticMarkup(await ReleaseHistoryView({ ...scope, before: '5' }));
    expect(mocks.list).toHaveBeenCalledWith({
      ...scope,
      merchantUserId: userId,
      beforeReleaseNo: 5,
    });
    expect(html).toContain(`/history/${releaseId}`);
    expect(html).toContain('/history?before=1');
    expect(html).not.toContain('原版商品价格29元');
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it('shows the selected historical facts and scopes any restore form to that source', async () => {
    const html = renderToStaticMarkup(await ReleaseHistoryView({ ...scope, releaseId }));
    expect(mocks.source).toHaveBeenCalledWith({ ...scope, merchantUserId: userId, releaseId });
    expect(html).toContain('原版商品价格29元');
    expect(html).toContain(`data-restore-source="${releaseId}"`);
    expect(html).toContain('恢复到草稿，不直接上线');
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('does not render a restore control for a read-only member', async () => {
    mocks.source.mockResolvedValue({ ...item, canRestore: false, draft });
    const html = renderToStaticMarkup(await ReleaseHistoryView({ ...scope, releaseId }));
    expect(html).toContain('当前账号仅可查看');
    expect(html).not.toContain('data-restore-source');
  });
  it('does not turn failed reads into an empty history or restore button', async () => {
    mocks.list.mockRejectedValue(Error('unavailable'));
    const html = renderToStaticMarkup(await ReleaseHistoryView(scope));
    expect(html).toContain('发布历史暂不可用');
    expect(html).not.toContain('暂无发布历史');
  });
  it('rejects a foreign/missing source and malformed cursor before exposing facts', async () => {
    mocks.source.mockResolvedValue(null);
    await expect(ReleaseHistoryView({ ...scope, releaseId })).rejects.toThrow('not_found');
    await expect(ReleaseHistoryView({ ...scope, before: ['1', '2'] })).rejects.toThrow('not_found');
  });
  it('retains the exact validated history destination through a logged-out redirect', async () => {
    mocks.current.mockResolvedValue(null);
    await expect(ReleaseHistoryView({ ...scope, releaseId })).rejects.toThrow(
      encodeURIComponent(`/${merchantId}/publish/${assistantId}/history/${releaseId}`),
    );
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it('does not confuse an empty older page with no publication history at all', async () => {
    mocks.list.mockResolvedValue({ items: [], nextBeforeReleaseNo: null });
    const html = renderToStaticMarkup(await ReleaseHistoryView({ ...scope, before: '1' }));
    expect(html).toContain('没有更早的发布版本');
    expect(html).not.toContain('暂无发布历史');
  });
});
