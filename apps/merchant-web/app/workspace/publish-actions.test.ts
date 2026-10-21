import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  origin: vi.fn(),
  current: vi.fn(),
  worker: vi.fn(),
  api: vi.fn(),
  configured: vi.fn(),
  snapshot: vi.fn(),
  confirm: vi.fn(),
  publish: vi.fn(),
  publicSnapshot: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: mocks.origin }) }));
vi.mock('../account/merchant-actions', () => ({ currentMerchantForWrite: mocks.current }));
vi.mock('./worker-readiness', () => ({ workerReady: mocks.worker }));
vi.mock('./api-readiness', () => ({ publicApiReady: mocks.api }));
vi.mock('./publication-policy', () => ({
  publicationPolicy: mocks.policy,
  publicAssistantUrl: (origin: string, slug: string) =>
    /^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug) ? `${origin}/a/${slug}` : null,
}));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: mocks.configured,
  MySqlAssistantLifecycleRepository: class {
    findManagementSnapshot = mocks.snapshot;
    confirmDraftKnowledge = mocks.confirm;
    publish = mocks.publish;
    findPublicSnapshot = mocks.publicSnapshot;
  },
}));
import { AssistantRevisionConflictError } from '@h5cs/domain';
import {
  confirmAndPublishAssistantAction,
  publishAssistantAction,
  type PublishAssistantState,
} from './publish-actions';

const merchantId = 'a'.repeat(32),
  assistantId = 'b'.repeat(32),
  userId = 'c'.repeat(32);
const policy = {
  ready: true,
  consumerOrigin: 'https://customer.test',
  promptTemplateVersion: 'p1',
  retrievalPolicyVersion: 'r1',
  modelPolicyVersion: 'm1',
};
const draft = {
  publicSlug: 'a-fixed-shop',
  draftRevision: 4,
  knowledgeConfirmed: false,
  status: 'draft',
};
const release = { releaseId: 'd'.repeat(32), releaseNo: 1 };
const initial: PublishAssistantState = {
  error: null,
  published: false,
  publicUrl: null,
  releaseNo: null,
};
function form() {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    merchantId,
    assistantId,
    draftRevision: '4',
    idempotencyKey: '11111111-2222-4333-8444-555555555555',
    csrfToken: 'owned-csrf',
    confirmAndPublish: 'yes',
  }))
    f.set(k, v);
  return f;
}

describe('explicit single-step knowledge confirmation and publication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', 'https://merchant.test');
    mocks.origin.mockReturnValue('https://merchant.test');
    mocks.policy.mockReturnValue(policy);
    mocks.current.mockResolvedValue({ merchantUserId: userId });
    mocks.worker.mockResolvedValue(true);
    mocks.api.mockResolvedValue(true);
    mocks.configured.mockReturnValue({ configured: true, config: {} });
    mocks.snapshot.mockResolvedValue(draft);
    mocks.confirm.mockResolvedValue({ knowledgeRevisionId: 'e'.repeat(32), draftRevision: 4 });
    mocks.publish.mockResolvedValue(release);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('confirms the exact authorized revision and then actually publishes with stable persisted slug', async () => {
    const state = await confirmAndPublishAssistantAction(initial, form());
    expect(mocks.current).toHaveBeenCalledWith(merchantId, 'owned-csrf');
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId,
        assistantId,
        merchantUserId: userId,
        expectedDraftRevision: 4,
      }),
    );
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId,
        assistantId,
        expectedDraftRevision: 4,
        idempotency: expect.objectContaining({
          actorScopeDigest: expect.any(Uint8Array),
          keyDigest: expect.any(Uint8Array),
          requestHash: expect.any(Uint8Array),
        }),
      }),
    );
    expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0]!,
    );
    expect(state).toEqual({
      published: true,
      error: null,
      releaseNo: 1,
      publicUrl: 'https://customer.test/a/a-fixed-shop',
    });
    expect(mocks.publicSnapshot).not.toHaveBeenCalled();
  });
  it('does not strand an already-confirmed but unpublished draft', async () => {
    mocks.snapshot.mockResolvedValue({ ...draft, knowledgeConfirmed: true });
    expect((await confirmAndPublishAssistantAction(initial, form())).published).toBe(true);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });
  it('requires explicit combined consent, not just the old publication checkbox', async () => {
    const f = form();
    f.delete('confirmAndPublish');
    f.set('publishConfirmed', 'yes');
    expect((await confirmAndPublishAssistantAction(initial, f)).published).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('keeps the legacy publish action strict instead of silently confirming for old clients', async () => {
    const f = form();
    f.set('publishConfirmed', 'yes');
    expect((await publishAssistantAction(initial, f)).published).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it.each(['origin', 'csrf', 'session', 'policy', 'worker', 'api', 'database'])(
    `rejects unavailable %s before any confirmation/publication write`,
    async (failure) => {
      if (failure === 'origin') mocks.origin.mockReturnValue('https://other.test');
      if (failure === 'csrf' || failure === 'session') mocks.current.mockResolvedValue(null);
      if (failure === 'policy') mocks.policy.mockReturnValue({ ready: false, reason: 'not ready' });
      if (failure === 'worker') mocks.worker.mockResolvedValue(false);
      if (failure === 'api') mocks.api.mockResolvedValue(false);
      if (failure === 'database') mocks.configured.mockReturnValue({ configured: false });
      const state = await confirmAndPublishAssistantAction(initial, form());
      expect(state.published).toBe(false);
      expect(state.publicUrl).toBeNull();
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    },
  );
  it.each([{ ...draft, status: 'paused' }, { ...draft, draftRevision: 5 }, null])(
    'rejects a paused, missing or changed draft before writes',
    async (snapshot) => {
      mocks.snapshot.mockResolvedValue(snapshot);
      expect((await confirmAndPublishAssistantAction(initial, form())).published).toBe(false);
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
    },
  );
  it('does not publish when confirmation detects a changed revision/member', async () => {
    mocks.confirm.mockRejectedValue(new AssistantRevisionConflictError());
    const state = await confirmAndPublishAssistantAction(initial, form());
    expect(state.published).toBe(false);
    expect(state.publicUrl).toBeNull();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('does not fake success/link if publication fails after confirmation', async () => {
    mocks.publish.mockRejectedValue(new AssistantRevisionConflictError());
    const state = await confirmAndPublishAssistantAction(initial, form());
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(state.published).toBe(false);
    expect(state.publicUrl).toBeNull();
    expect(state.error).toContain('仅资料确认不代表已发布');
  });
  it('uses the same idempotency request when confirmation was already committed on a retry', async () => {
    await confirmAndPublishAssistantAction(initial, form());
    const first = mocks.publish.mock.calls[0]![0];
    mocks.snapshot.mockResolvedValue({ ...draft, knowledgeConfirmed: true });
    await confirmAndPublishAssistantAction(initial, form());
    const second = mocks.publish.mock.calls[1]![0];
    expect(second.idempotency.actorScopeDigest).toEqual(first.idempotency.actorScopeDigest);
    expect(second.idempotency.keyDigest).toEqual(first.idempotency.keyDigest);
    expect(second.idempotency.requestHash).toEqual(first.idempotency.requestHash);
  });
  it('v1/v2 share the same URL and do not depend on a flaky extra public read', async () => {
    const first = await confirmAndPublishAssistantAction(initial, form());
    mocks.publish.mockResolvedValue({ ...release, releaseId: 'f'.repeat(32), releaseNo: 2 });
    mocks.snapshot.mockResolvedValue({ ...draft, draftRevision: 5, knowledgeConfirmed: false });
    const f = form();
    f.set('draftRevision', '5');
    const second = await confirmAndPublishAssistantAction(initial, f);
    expect(first.publicUrl).toBe(second.publicUrl);
    expect(second.releaseNo).toBe(2);
    expect(mocks.publicSnapshot).not.toHaveBeenCalled();
  });
});
