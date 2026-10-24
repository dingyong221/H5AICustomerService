import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  origin: vi.fn(),
  member: vi.fn(),
  config: vi.fn(),
  rename: vi.fn(),
  judge: vi.fn(),
  withdraw: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: mocks.origin }) }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.refresh }));
vi.mock('../account/merchant-actions', () => ({ currentMerchantForWrite: mocks.member }));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: mocks.config,
  MySqlAssistantLifecycleRepository: class {
    renameAssistant = mocks.rename;
    judgePreviewCheck = mocks.judge;
    emergencyWithdraw = mocks.withdraw;
  },
}));
import {
  emergencyWithdrawAction,
  judgePreviewCheckAction,
  renameAssistantAction,
} from './governance-actions';
const merchantId = 'aa'.repeat(16),
  assistantId = 'bb'.repeat(16),
  userId = 'cc'.repeat(16),
  releaseId = 'dd'.repeat(16),
  checkId = 'ee'.repeat(16);
const initial = { error: null, saved: false };
function form(extra: Record<string, string> = {}) {
  const data = new FormData();
  for (const [k, v] of Object.entries({
    merchantId,
    assistantId,
    draftRevision: '4',
    csrfToken: 'safe',
    ...extra,
  }))
    data.set(k, v);
  return data;
}
describe('merchant governance actions security and explicit intent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', 'https://merchant.test');
    mocks.origin.mockReturnValue('https://merchant.test');
    mocks.member.mockResolvedValue({ merchantUserId: userId });
    mocks.config.mockReturnValue({ configured: true, config: {} });
    mocks.rename.mockResolvedValue({});
    mocks.judge.mockResolvedValue(undefined);
    mocks.withdraw.mockResolvedValue({ withdrawnReleaseCount: 2, endedSessionCount: 3 });
  });
  it('renames the precise revision without creating another assistant or changing its public slug', async () => {
    expect(await renameAssistantAction(initial, form({ displayName: '新客服' }))).toEqual({
      error: null,
      saved: true,
    });
    expect(mocks.rename).toHaveBeenCalledWith({
      merchantId,
      assistantId,
      merchantUserId: userId,
      expectedRevision: 4,
      displayName: '新客服',
      now: expect.any(Date),
    });
    expect(mocks.refresh).toHaveBeenCalledWith(`/${merchantId}`);
  });
  it('records an explicit verdict only against the server-issued check and draft revision', async () => {
    expect(
      (
        await judgePreviewCheckAction(
          initial,
          form({ checkId, verdict: 'pass', reviewConfirmed: 'yes' }),
        )
      ).saved,
    ).toBe(true);
    expect(mocks.judge).toHaveBeenCalledWith({
      merchantId,
      assistantId,
      merchantUserId: userId,
      expectedDraftRevision: 4,
      checkId,
      verdict: 'pass',
      now: expect.any(Date),
    });
  });
  it('requires reason, release CAS and impact consent before emergency withdrawal', async () => {
    for (const changed of [
      { reason: '错误', withdrawalConfirmed: 'yes', expectedReleaseId: releaseId },
      { reason: '发现价格错误需要核对', expectedReleaseId: releaseId },
      { reason: '发现价格错误需要核对', withdrawalConfirmed: 'yes', expectedReleaseId: 'foreign' },
    ])
      expect((await emergencyWithdrawAction(initial, form(changed))).saved).toBe(false);
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(
      (
        await emergencyWithdrawAction(
          initial,
          form({
            reason: '发现价格错误需要核对',
            withdrawalConfirmed: 'yes',
            expectedReleaseId: releaseId,
          }),
        )
      ).saved,
    ).toBe(true);
    expect(mocks.withdraw).toHaveBeenCalledWith({
      merchantId,
      assistantId,
      merchantUserId: userId,
      expectedReleaseId: releaseId,
      reason: '发现价格错误需要核对',
      now: expect.any(Date),
    });
  });
  it('rejects foreign origin, wrong scope, missing security and stale authorization without writes', async () => {
    mocks.origin.mockReturnValue('https://other.test');
    expect((await renameAssistantAction(initial, form({ displayName: '新名称' }))).saved).toBe(
      false,
    );
    mocks.origin.mockReturnValue('https://merchant.test');
    expect(
      (await renameAssistantAction(initial, form({ merchantId: 'invalid', displayName: '新名称' })))
        .saved,
    ).toBe(false);
    mocks.member.mockResolvedValue(null);
    expect(
      (
        await judgePreviewCheckAction(
          initial,
          form({ checkId, verdict: 'pass', reviewConfirmed: 'yes' }),
        )
      ).saved,
    ).toBe(false);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.judge).not.toHaveBeenCalled();
  });
  it('does not accept browser-provided answers or implicit review and does not leak internal exceptions', async () => {
    expect(
      (
        await judgePreviewCheckAction(
          initial,
          form({ checkId, verdict: 'pass', answer: '伪造回答' }),
        )
      ).saved,
    ).toBe(false);
    expect(mocks.judge).not.toHaveBeenCalled();
    mocks.rename.mockRejectedValue(new Error('db credential secret'));
    const result = await renameAssistantAction(initial, form({ displayName: '新名称' }));
    expect(result.saved).toBe(false);
    expect(result.error).toContain('刷新核对');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
