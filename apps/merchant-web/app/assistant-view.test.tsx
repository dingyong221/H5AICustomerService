import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  governance: vi.fn(),
  materials: vi.fn(),
  worker: vi.fn(),
  api: vi.fn(),
  policy: vi.fn(),
  sharingOrigin: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not_found');
  },
  redirect: () => {
    throw new Error('redirect');
  },
}));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', props, children),
}));
vi.mock('@h5cs/ui', () => ({
  PageShell: ({ children, title }: { children: React.ReactNode; title: string }) =>
    React.createElement('main', null, React.createElement('h1', null, title), children),
  StatusBadge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: () => ({ configured: true, config: {} }),
  MySqlAssistantLifecycleRepository: class {
    findManagementSnapshot = mocks.snapshot;
    getPublicationGovernance = mocks.governance;
  },
  MySqlMarketplaceRepository: class {
    quotaForMerchant = async () => null;
  },
  MySqlKnowledgeMaterialRepository: class {
    list = mocks.materials;
  },
}));
vi.mock('./account/merchant-actions', () => ({
  currentMerchant: async () => ({ merchantUserId: 'cc'.repeat(16) }),
  currentMerchantCsrfToken: async () => 'test-csrf',
}));
vi.mock('./workspace/publication-policy', () => ({
  publicationPolicy: mocks.policy,
  publicSharingOrigin: mocks.sharingOrigin,
  publicAssistantUrl: (origin: string, slug: string) => `${origin}/a/${slug}`,
}));
vi.mock('./workspace/worker-readiness', () => ({ workerReady: mocks.worker }));
vi.mock('./workspace/api-readiness', () => ({ publicApiReady: mocks.api }));
vi.mock('./workspace/confirm-knowledge-form', () => ({
  ConfirmKnowledgeForm: ({ draftRevision }: { draftRevision: number }) =>
    React.createElement('form', { 'data-confirm-revision': draftRevision }),
}));
vi.mock('./workspace/publish-assistant-form', () => ({
  PublishAssistantForm: ({
    ready,
    reason,
    draftRevision,
  }: {
    ready: boolean;
    reason: string | null;
    draftRevision: number;
  }) =>
    React.createElement('form', {
      'data-publish-ready': ready,
      'data-reason': reason,
      'data-publish-revision': draftRevision,
    }),
}));
vi.mock('./share-assistant-link', () => ({
  ShareAssistantLink: ({ href }: { href: string }) =>
    React.createElement('a', { 'data-fixed-link': true, href }, '复制消费者链接'),
}));
vi.mock('./workspace/edit-draft-form', () => ({
  EditDraftForm: ({ continueHref }: { continueHref: string }) =>
    React.createElement('form', { 'data-edit': true, 'data-continue-href': continueHref }),
}));
vi.mock('./workspace/draft-readiness-panel', () => ({
  DraftReadinessPanel: () => React.createElement('section', { 'data-readiness': true }),
}));
vi.mock('./workspace/draft-revision-notice', () => ({ DraftRevisionNotice: () => null }));
vi.mock('./workspace/preview-chat-form', () => ({
  PreviewChatForm: () => React.createElement('form', { 'data-preview': true }),
}));
vi.mock('./workspace/governance-controls', () => ({
  RenameAssistantForm: () => React.createElement('form', { 'data-rename': true }),
  EmergencyWithdrawForm: () => React.createElement('form', { 'data-withdraw': true }),
}));
vi.mock('./improvements/improvement-summary', () => ({ ImprovementSummaryPanel: () => null }));
vi.mock('./knowledge/material-manager', () => ({
  MaterialManager: ({ assistantId }: { assistantId: string }) =>
    React.createElement('section', { 'data-materials-assistant': assistantId }),
}));

import { AssistantView } from './assistant-view';

const merchantId = 'aa'.repeat(16);
const assistantId = 'bb'.repeat(16);
const assistant = {
  displayName: '测试客服',
  publicSlug: 'test-assistant',
  draftRevision: 3,
  knowledgeConfirmed: false,
  activeReleaseId: null,
  status: 'active',
  draft: {
    industry: '零售',
    businessScope: '商品咨询',
    materialsSummary: '已核对的商品资料',
    pricingSummary: '价格待确认',
    promotionSummary: '优惠待确认',
    welcomeMessage: '你好',
    insufficientInfoMessage: '请联系商家核实',
    humanContact: '',
  },
};
const governance = {
  draftRevision: 3,
  activeReleaseNo: null,
  activeDraftRevision: null,
  hasUnpublishedChanges: true,
  hasPublishedHistory: false,
  canManage: true,
  quality: { state: 'passed', checkId: null, question: null, answer: null, testedAt: null },
  issues: [],
  capacity: {
    effectiveCharacters: 10,
    maximumCharacters: 4000,
    uploadedMaterialCount: 0,
    sourceCoverage: 'not_tracked',
  },
  withdrawal: { withdrawnThroughReleaseNo: 0, withdrawnAt: null, reason: null },
};

describe('assistant publication flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    mocks.snapshot.mockResolvedValue(assistant);
    mocks.governance.mockReset().mockResolvedValue(governance);
    mocks.materials.mockResolvedValue([]);
    mocks.worker.mockResolvedValue(true);
    mocks.api.mockResolvedValue(true);
    mocks.policy.mockReturnValue({
      ready: true,
      consumerOrigin: 'https://example.test',
      promptTemplateVersion: 'p1',
      retrievalPolicyVersion: 'r1',
      modelPolicyVersion: 'm1',
    });
    mocks.sharingOrigin.mockReturnValue('https://example.test');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers one combined publication entry for the exact unconfirmed revision', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).toContain('确认资料并发布');
    expect(html).not.toContain('data-confirm-revision');
    expect(html).toContain('data-publish-revision="3"');
    expect(html).toContain('data-publish-ready="true"');
    expect(html).not.toContain('data-fixed-link');
    expect(html.match(/data-publish-ready=/gu)).toHaveLength(1);
  });

  it('keeps confirmed-but-unpublished drafts publishable without another disabled confirmation step', async () => {
    mocks.snapshot.mockResolvedValue({ ...assistant, knowledgeConfirmed: true });
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).not.toContain('data-confirm-revision');
    expect(html).toContain('data-publish-ready="true"');
  });

  it('makes file upload the second workflow step without duplicating editing or publishing', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'knowledge' }),
    );
    expect(mocks.materials).toHaveBeenCalledWith(merchantId, assistantId, 'cc'.repeat(16));
    expect(html).toContain(`data-materials-assistant="${assistantId}"`);
    expect(html).not.toContain('data-confirm-revision');
    expect(html).toContain('<h1>知识补充</h1>');
    expect(html).toContain('下一步：效果试聊');
    expect(html).toContain(`href="/${merchantId}/preview/${assistantId}"`);
    expect(html).toContain('查看已保存的商品与服务资料');
    expect(html).not.toContain('data-publish-ready');
    expect(html).not.toContain('data-edit');
    expect(html).not.toContain('data-preview');
    expect(html).not.toContain('data-readiness');
  });

  it('uses the latest revision when editing invalidates an earlier confirmation', async () => {
    mocks.snapshot.mockResolvedValue({ ...assistant, draftRevision: 4 });
    mocks.governance.mockResolvedValue({
      ...governance,
      draftRevision: 4,
      quality: { ...governance.quality, state: 'not_tested' },
    });
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).toContain('data-publish-revision="4"');
    expect(html).not.toContain('data-publish-revision="3"');
    expect(html).toContain('data-publish-ready="false"');
    expect(html).toContain('请成功试聊当前修订');
  });
  it('keeps the permanent address visible after emergency withdrawal without claiming it can take new consultations', async () => {
    mocks.governance.mockResolvedValue({
      ...governance,
      hasPublishedHistory: true,
      withdrawal: {
        withdrawnThroughReleaseNo: 2,
        withdrawnAt: '2026-10-24T00:00:00Z',
        reason: '发现价格错误',
      },
    });
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).toContain('href="https://example.test/a/test-assistant"');
    expect(html).toContain('已紧急撤回');
    expect(html).toContain('当前不能接待咨询');
    expect(html).not.toContain('data-withdraw');
  });
  it('does not bypass unavailable publication checks and does not render management controls to a viewer', async () => {
    mocks.governance.mockRejectedValueOnce(new Error('unavailable'));
    const failed = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(failed).toContain('data-publish-ready="false"');
    expect(failed).toContain('发布检查暂不可用');
    mocks.governance.mockResolvedValue({ ...governance, canManage: false });
    const viewer = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'drafts' }),
    );
    expect(viewer).not.toContain('data-rename');
  });

  it.each(['drafts', 'knowledge', 'preview', 'publish'] as const)(
    'retains the same persisted link on %s, refresh and a newer draft',
    async (section) => {
      mocks.snapshot.mockResolvedValue({ ...assistant, activeReleaseId: 'dd'.repeat(16) });
      const first = renderToStaticMarkup(await AssistantView({ merchantId, assistantId, section }));
      mocks.snapshot.mockResolvedValue({
        ...assistant,
        activeReleaseId: 'ee'.repeat(16),
        draftRevision: 4,
      });
      const next = renderToStaticMarkup(await AssistantView({ merchantId, assistantId, section }));
      for (const html of [first, next]) {
        expect(html).toContain('固定消费者链接');
        expect(html).toContain('href="https://example.test/a/test-assistant"');
      }
    },
  );
  it.each(['worker', 'api', 'policy', 'paused'])(
    'does not erase an actually published URL during temporary %s unavailability',
    async (unavailable) => {
      mocks.snapshot.mockResolvedValue({
        ...assistant,
        activeReleaseId: 'dd'.repeat(16),
        ...(unavailable === 'paused' ? { status: 'paused' } : {}),
      });
      if (unavailable === 'worker') mocks.worker.mockResolvedValue(false);
      if (unavailable === 'api') mocks.api.mockResolvedValue(false);
      if (unavailable === 'policy')
        mocks.policy.mockReturnValue({ ready: false, reason: '模型暂不可用' });
      const html = renderToStaticMarkup(
        await AssistantView({ merchantId, assistantId, section: 'publish' }),
      );
      expect(html).toContain('href="https://example.test/a/test-assistant"');
      expect(html).toContain('固定地址仍保留');
      expect(html).toContain('data-publish-ready="false"');
    },
  );
  it('never invents a published URL before a persisted active release exists', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).not.toContain('href="https://example.test/a/test-assistant"');
    expect(html).toContain('当前尚未发布');
  });
  it('does not substitute an unsafe/unconfigured origin when a published URL cannot be rendered', async () => {
    mocks.snapshot.mockResolvedValue({ ...assistant, activeReleaseId: 'dd'.repeat(16) });
    mocks.sharingOrigin.mockReturnValue(null);
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'drafts' }),
    );
    expect(html).toContain('正式域名配置暂不可用');
    expect(html).not.toContain('data-fixed-link');
  });

  it('keeps step one focused on editing and saves before continuing to file upload', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'drafts' }),
    );
    expect(html).toContain('<h1>基础资料</h1>');
    expect(html).toContain('data-edit="true"');
    expect(html).toContain(`data-continue-href="/${merchantId}/knowledge/${assistantId}"`);
    expect(html).not.toContain('data-materials-assistant');
    expect(html).not.toContain('data-preview');
    expect(html).not.toContain('data-publish-ready');
    expect(html).not.toContain('data-readiness');
  });

  it('isolates test chat from publication and provides a clear next step', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'preview' }),
    );
    expect(html).toContain('<h1>效果试聊</h1>');
    expect(html).toContain('data-preview="true"');
    expect(html).toContain('下一步：发布分享');
    expect(html).not.toContain('data-edit');
    expect(html).not.toContain('data-materials-assistant');
    expect(html).not.toContain('data-publish-ready');
  });

  it('keeps review and publication only in the final step', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).toContain('<h1>发布分享</h1>');
    expect(html).toContain('发布内容核对');
    expect(html).toContain('data-readiness="true"');
    expect(html).toContain('data-publish-revision="3"');
    expect(html).not.toContain('data-preview');
    expect(html).not.toContain('data-edit');
    expect(html).not.toContain('data-materials-assistant');
  });

  it('shows the four scoped steps without claiming that merely visiting a step completed it', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'knowledge' }),
    );
    expect(html).toContain('aria-label="客服发布步骤"');
    expect(html.match(/aria-current="step"/gu)).toHaveLength(1);
    for (const section of ['drafts', 'knowledge', 'preview', 'publish']) {
      expect(html).toContain(`href="/${merchantId}/${section}/${assistantId}"`);
    }
    expect(html).not.toContain('已完成');
  });
});
