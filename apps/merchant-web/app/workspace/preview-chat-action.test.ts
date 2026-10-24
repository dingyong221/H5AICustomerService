import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  origin: vi.fn(),
  member: vi.fn(),
  snapshot: vi.fn(),
  generate: vi.fn(),
  config: vi.fn(),
  editAccess: vi.fn(),
  record: vi.fn(),
  AccessError: class extends Error {},
  RateLimitError: class extends Error {},
}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: mocks.origin }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../account/merchant-actions', () => ({ currentMerchantForWrite: mocks.member }));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: mocks.config,
  MySqlAssistantLifecycleRepository: class {
    findManagementSnapshot = mocks.snapshot;
    savePreviewCheck = mocks.record;
  },
  MySqlKnowledgeMaterialRepository: class {
    assertEditable = mocks.editAccess;
  },
  KnowledgeMaterialAccessError: mocks.AccessError,
}));
vi.mock('./worker-preview', () => ({
  requestWorkerPreview: mocks.generate,
  WorkerPreviewRateLimitError: mocks.RateLimitError,
}));
import { previewChatAction } from './preview-chat-action';
import { retailDefaultDraft } from './retail-preset';
const origin = 'https://h5cs.1rying.com',
  merchantId = 'aa'.repeat(16),
  assistantId = 'bb'.repeat(16);
const snapshot = {
  displayName: '合成零售客服',
  draftRevision: 2,
  status: 'draft',
  draft: { ...retailDefaultDraft, materialsSummary: '【来源：商品表.csv】\n保温杯39元/件' },
};
const previous = { answer: null, error: null, revision: null };
function form() {
  const data = new FormData();
  for (const [k, v] of Object.entries({
    merchantId,
    assistantId,
    draftRevision: '2',
    csrfToken: 'synthetic',
    question: '保温杯多少钱？',
  }))
    data.set(k, v);
  return data;
}
describe('real draft input evidence boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editAccess.mockReset().mockResolvedValue(undefined);
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', origin);
    mocks.origin.mockReturnValue(origin);
    mocks.member.mockResolvedValue({ merchantUserId: 'cc'.repeat(16) });
    mocks.config.mockReturnValue({ configured: true, config: {} });
    mocks.snapshot.mockResolvedValue(snapshot);
    mocks.generate.mockResolvedValue('保温杯39元/件。');
    mocks.record.mockReset().mockResolvedValue({ checkId: 'dd'.repeat(16), draftRevision: 2 });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('returns only the actually requested revision and its exact persisted facts after the provider succeeds', async () => {
    const result = await previewChatAction(previous, form());
    expect(result).toMatchObject({ answer: '保温杯39元/件。', error: null, revision: 2 });
    expect(result.checkId).toBe('dd'.repeat(16));
    expect(result.evidence).toContainEqual({
      label: '商品与服务资料（含已保存的来源标记）',
      text: snapshot.draft.materialsSummary,
    });
    expect(mocks.generate).toHaveBeenCalledWith({
      merchantId,
      assistantName: snapshot.displayName,
      draft: snapshot.draft,
      question: '保温杯多少钱？',
    });
  });
  it('retains a generated answer but never grants a review ID when the trusted record cannot be persisted', async () => {
    mocks.record.mockRejectedValue(new Error('private database detail'));
    const result = await previewChatAction(previous, form());
    expect(result.answer).toBe('保温杯39元/件。');
    expect(result.checkId).toBeNull();
    expect(result.error).toContain('不能用于发布判定');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('does not call models or disclose facts for foreign origin, denied member, unavailable DB, stale revision or paused assistant', async () => {
    mocks.origin.mockReturnValue('https://untrusted.invalid');
    expect((await previewChatAction(previous, form())).answer).toBeNull();
    mocks.origin.mockReturnValue(origin);
    mocks.member.mockResolvedValue(null);
    expect((await previewChatAction(previous, form())).answer).toBeNull();
    mocks.member.mockResolvedValue({ merchantUserId: 'cc'.repeat(16) });
    mocks.config.mockReturnValue({ configured: false });
    expect((await previewChatAction(previous, form())).answer).toBeNull();
    mocks.config.mockReturnValue({ configured: true, config: {} });
    mocks.snapshot.mockResolvedValue({ ...snapshot, draftRevision: 3 });
    expect((await previewChatAction(previous, form())).answer).toBeNull();
    mocks.snapshot.mockResolvedValue({ ...snapshot, status: 'paused' });
    const paused = await previewChatAction(previous, form());
    expect(paused.answer).toBeNull();
    expect(paused.evidence).toBeUndefined();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('keeps provider internals private and never returns an evidence panel for a failed model call', async () => {
    mocks.generate.mockRejectedValue(new Error('private upstream detail'));
    const result = await previewChatAction(previous, form());
    expect(result.error).toBe('试聊服务暂不可用，请稍后重试。');
    expect(result.evidence).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('explains a confirmed Worker rate limit without recording a passing trial or retrying it', async () => {
    mocks.generate.mockRejectedValue(new mocks.RateLimitError());
    const result = await previewChatAction(previous, form());
    expect(result).toMatchObject({ answer: null, error: '试聊请求较频繁，请一分钟后重试。' });
    expect(result.checkId).toBeUndefined();
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('requires exact assistant edit permission before reading draft or invoking a paid model', async () => {
    mocks.editAccess.mockRejectedValue(new mocks.AccessError());
    const denied = await previewChatAction(previous, form());
    expect(denied.error).toBe('登录已失效或无权试聊此客服。');
    expect(denied.evidence).toBeUndefined();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
