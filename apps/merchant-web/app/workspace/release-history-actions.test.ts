import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  origin: vi.fn(),
  session: vi.fn(),
  configured: vi.fn(),
  restore: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: mocks.origin }) }));
vi.mock('../account/merchant-actions', () => ({ currentMerchantForWrite: mocks.session }));
vi.mock('@h5cs/database', async (importActual) => ({
  ...(await importActual<typeof import('@h5cs/database')>()),
  loadDatabaseConfig: mocks.configured,
  MySqlAssistantLifecycleRepository: class {
    restoreDraftFromRelease = mocks.restore;
  },
}));
import { AssistantRevisionConflictError } from '@h5cs/domain';
import { AssistantHistorySourceUnavailableError } from '@h5cs/database';
import { restoreReleaseToDraftAction } from './release-history-actions';

const merchantId = 'aa'.repeat(16),
  assistantId = 'bb'.repeat(16),
  releaseId = 'cc'.repeat(16),
  userId = 'dd'.repeat(16);
const initial = { error: null, restored: null };
function form() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    merchantId,
    assistantId,
    releaseId,
    draftRevision: '4',
    csrfToken: 'owned-csrf',
    restoreConfirmed: 'yes',
  }))
    data.set(key, value);
  return data;
}
describe('explicit historical release recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', 'https://merchant.test');
    mocks.origin.mockReturnValue('https://merchant.test');
    mocks.session.mockResolvedValue({ merchantUserId: userId });
    mocks.configured.mockReturnValue({ configured: true, config: {} });
    mocks.restore.mockResolvedValue({
      assistant: { merchantId, assistantId, draftRevision: 5, knowledgeConfirmed: false },
      sourceReleaseNo: 1,
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('restores only the exact scoped revision with CSRF and no publication side effect', async () => {
    await expect(restoreReleaseToDraftAction(initial, form())).resolves.toEqual({
      error: null,
      restored: { draftRevision: 5, sourceReleaseNo: 1 },
    });
    expect(mocks.session).toHaveBeenCalledWith(merchantId, 'owned-csrf');
    expect(mocks.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId,
        assistantId,
        releaseId,
        merchantUserId: userId,
        expectedRevision: 4,
      }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith(
      `/${merchantId}/publish/${assistantId}/history/${releaseId}`,
    );
    expect(mocks.revalidate.mock.calls.some(([path]) => String(path).startsWith('/a/'))).toBe(
      false,
    );
  });
  it('rejects a bad origin before checking any session or database', async () => {
    mocks.origin.mockReturnValue('https://foreign.test');
    expect((await restoreReleaseToDraftAction(initial, form())).restored).toBeNull();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.configured).not.toHaveBeenCalled();
  });
  it.each([
    ['merchantId', '../bad'],
    ['assistantId', 'bad'],
    ['releaseId', 'bad'],
    ['draftRevision', '0'],
    ['restoreConfirmed', 'no'],
    ['csrfToken', null],
  ])('rejects invalid scope, missing consent or security fields: %s', async (key, value) => {
    const data = form();
    if (value === null) data.delete(key!);
    else data.set(key!, value!);
    expect((await restoreReleaseToDraftAction(initial, data)).restored).toBeNull();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it('stops before reading history when session/CSRF cannot be verified', async () => {
    mocks.session.mockResolvedValue(null);
    expect((await restoreReleaseToDraftAction(initial, form())).restored).toBeNull();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it.each([
    new AssistantRevisionConflictError(),
    new AssistantHistorySourceUnavailableError(),
    new Error('internal DB details'),
  ])(
    'does not retry or claim success on source, revision, access or unknown errors',
    async (error) => {
      mocks.restore.mockRejectedValue(error);
      const result = await restoreReleaseToDraftAction(initial, form());
      expect(result.restored).toBeNull();
      expect(result.error).toBeTruthy();
      expect(result.error).not.toContain('internal DB details');
      expect(mocks.restore).toHaveBeenCalledOnce();
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );
  it('does not report an unexpected write result as a verified restoration', async () => {
    mocks.restore.mockResolvedValue({
      assistant: { merchantId, assistantId, draftRevision: 4, knowledgeConfirmed: true },
      sourceReleaseNo: 1,
    });
    expect((await restoreReleaseToDraftAction(initial, form())).error).toContain('不要重复提交');
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
