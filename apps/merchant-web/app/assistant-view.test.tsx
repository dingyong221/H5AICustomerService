import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
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
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}));
vi.mock('@h5cs/ui', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) =>
    React.createElement('main', null, children),
  StatusBadge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: () => ({ configured: true, config: {} }),
  MySqlAssistantLifecycleRepository: class {
    findManagementSnapshot = mocks.snapshot;
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
vi.mock('./workspace/edit-draft-form', () => ({ EditDraftForm: () => null }));
vi.mock('./workspace/draft-readiness-panel', () => ({ DraftReadinessPanel: () => null }));
vi.mock('./workspace/draft-revision-notice', () => ({ DraftRevisionNotice: () => null }));
vi.mock('./workspace/preview-chat-form', () => ({ PreviewChatForm: () => null }));
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

describe('assistant publication flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    mocks.snapshot.mockResolvedValue(assistant);
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

  it('retains the scoped upload manager and the same single publication entry on knowledge', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'knowledge' }),
    );
    expect(mocks.materials).toHaveBeenCalledWith(merchantId, assistantId, 'cc'.repeat(16));
    expect(html).toContain(`data-materials-assistant="${assistantId}"`);
    expect(html).not.toContain('data-confirm-revision');
    expect(html).toContain('data-publish-revision="3"');
    expect(html.match(/data-publish-ready=/gu)).toHaveLength(1);
  });

  it('uses the latest revision when editing invalidates an earlier confirmation', async () => {
    mocks.snapshot.mockResolvedValue({ ...assistant, draftRevision: 4 });
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).toContain('data-publish-revision="4"');
    expect(html).not.toContain('data-publish-revision="3"');
    expect(html).toContain('data-publish-ready="true"');
  });

  it.each(['drafts', 'knowledge', 'publish'] as const)(
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
        await AssistantView({ merchantId, assistantId, section: 'knowledge' }),
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
});
