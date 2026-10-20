import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  materials: vi.fn(),
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
  publicationPolicy: () => ({
    ready: true,
    consumerOrigin: 'https://example.test',
    promptTemplateVersion: 'p1',
    retrievalPolicyVersion: 'r1',
    modelPolicyVersion: 'm1',
  }),
  publicAssistantUrl: () => null,
}));
vi.mock('./workspace/worker-readiness', () => ({ workerReady: async () => true }));
vi.mock('./workspace/api-readiness', () => ({ publicApiReady: async () => true }));
vi.mock('./workspace/confirm-knowledge-form', () => ({
  ConfirmKnowledgeForm: ({ draftRevision }: { draftRevision: number }) =>
    React.createElement('form', { 'data-confirm-revision': draftRevision }),
}));
vi.mock('./workspace/publish-assistant-form', () => ({
  PublishAssistantForm: ({ ready, reason }: { ready: boolean; reason: string | null }) =>
    React.createElement('form', { 'data-publish-ready': ready, 'data-reason': reason }),
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
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers confirmation for the exact unconfirmed revision on the publish page', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).toContain('先确认当前修订的业务资料');
    expect(html).toContain('data-confirm-revision="3"');
    expect(html).toContain('data-publish-ready="false"');
    expect(html).toContain('请先确认当前修订的业务资料');
  });

  it('removes the confirmation step and unlocks publishing after confirmation', async () => {
    mocks.snapshot.mockResolvedValue({ ...assistant, knowledgeConfirmed: true });
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).not.toContain('data-confirm-revision');
    expect(html).toContain('data-publish-ready="true"');
  });

  it('retains the scoped upload manager and confirmation on the knowledge page', async () => {
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'knowledge' }),
    );
    expect(mocks.materials).toHaveBeenCalledWith(merchantId, assistantId, 'cc'.repeat(16));
    expect(html).toContain(`data-materials-assistant="${assistantId}"`);
    expect(html).toContain('data-confirm-revision="3"');
    expect(html).not.toContain('先确认当前修订的业务资料');
    expect(html).not.toContain('data-publish-ready');
  });

  it('uses the latest revision when editing invalidates an earlier confirmation', async () => {
    mocks.snapshot.mockResolvedValue({ ...assistant, draftRevision: 4 });
    const html = renderToStaticMarkup(
      await AssistantView({ merchantId, assistantId, section: 'publish' }),
    );
    expect(html).toContain('data-confirm-revision="4"');
    expect(html).not.toContain('data-confirm-revision="3"');
    expect(html).toContain('data-publish-ready="false"');
  });
});
