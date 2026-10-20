import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  config: vi.fn(),
  headers: vi.fn(),
  verify: vi.fn(),
  database: vi.fn(),
  reset: vi.fn(),
  revalidate: vi.fn(),
  Conflict: class extends Error {},
}));
vi.mock('./operator-actions', () => ({ currentOperator: mocks.operator }));
vi.mock('./operator-auth', () => ({
  loadOperatorAuthConfig: mocks.config,
  verifyOperatorPassword: mocks.verify,
}));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: mocks.database,
  AccountResetConflict: mocks.Conflict,
  isMerchantPasswordResetReason: (value: string) =>
    ['忘记密码', '商家申请', '安全处理', '其他人工核对'].includes(value),
  MySqlMerchantAccountAdminRepository: class {
    reset = mocks.reset;
  },
}));
import { resetMerchantPassword } from './merchant-account-actions';

const merchant = '11'.repeat(16),
  user = '22'.repeat(16);
const password = 'SYNTHETIC-merchant-new-password';
const operatorPassword = 'SYNTHETIC-operator-password';
const previous = { error: null, done: false };
const form = (overrides: Record<string, string> = {}) => {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    merchantId: merchant,
    userId: user,
    version: 'a'.repeat(64),
    affectedMerchantIds: JSON.stringify([merchant]),
    password,
    passwordConfirm: password,
    reason: '忘记密码',
    operatorPassword,
    confirmed: 'yes',
    ...overrides,
  }))
    result.set(key, value);
  return result;
};

describe('operator password-reset server action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.mockReturnValue({ publicOrigin: 'https://ops.example.test' });
    mocks.operator.mockResolvedValue('synthetic-operator');
    mocks.headers.mockResolvedValue(new Headers({ origin: 'https://ops.example.test' }));
    mocks.verify.mockResolvedValue(true);
    mocks.database.mockReturnValue({ configured: true, config: { synthetic: true } });
    mocks.reset.mockResolvedValue(undefined);
  });

  it.each(['config', 'operator', 'origin'] as const)(
    'rejects missing or invalid %s before credential or database access',
    async (boundary) => {
      if (boundary === 'config') mocks.config.mockReturnValue(null);
      if (boundary === 'operator') mocks.operator.mockResolvedValue(null);
      if (boundary === 'origin')
        mocks.headers.mockResolvedValue(new Headers({ origin: 'https://attacker.invalid' }));
      expect((await resetMerchantPassword(previous, form())).done).toBe(false);
      expect(mocks.verify).not.toHaveBeenCalled();
      expect(mocks.database).not.toHaveBeenCalled();
      expect(mocks.reset).not.toHaveBeenCalled();
    },
  );

  it.each([
    { merchantId: 'bad' },
    { userId: 'bad' },
    { password: 'short' },
    { passwordConfirm: 'different-password' },
    { reason: password },
    { confirmed: '' },
  ])('rejects malformed input or pasted-secret audit text %j', async (override) => {
    expect((await resetMerchantPassword(previous, form(override))).done).toBe(false);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('requires the current operator password even with an authenticated session', async () => {
    mocks.verify.mockResolvedValue(false);
    expect((await resetMerchantPassword(previous, form())).error).toBe('运营密码验证失败。');
    expect(mocks.verify).toHaveBeenCalledWith(
      { publicOrigin: 'https://ops.example.test' },
      'synthetic-operator',
      operatorPassword,
    );
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it.each(['not-json', '{}', '[123]', '[{}]'])(
    'rejects malformed shared-account scope %s',
    async (affectedMerchantIds) => {
      expect((await resetMerchantPassword(previous, form({ affectedMerchantIds }))).done).toBe(
        false,
      );
      expect(mocks.reset).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the database is unavailable', async () => {
    mocks.database.mockReturnValue({ configured: false });
    expect((await resetMerchantPassword(previous, form())).error).toBe('数据库暂不可用。');
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('passes the exact expected scope to the repository and never returns either password', async () => {
    const result = await resetMerchantPassword(previous, form());
    expect(result).toEqual({ error: null, done: true });
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.reset).toHaveBeenCalledWith({
      merchantId: merchant,
      userId: user,
      password,
      reason: '忘记密码',
      expectedVersion: 'a'.repeat(64),
      affectedMerchantIds: [merchant],
      operatorId: 'synthetic-operator',
    });
    expect(JSON.stringify(mocks.reset.mock.calls)).not.toContain(operatorPassword);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(operatorPassword);
    expect(mocks.revalidate).toHaveBeenCalledWith(`/merchants/${merchant}`);
  });

  it('requires refreshed account data on stale-version conflicts', async () => {
    mocks.reset.mockRejectedValue(new mocks.Conflict());
    expect((await resetMerchantPassword(previous, form())).error).toBe(
      '账号或关联商家已变化，请刷新核对后重试。',
    );
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('does not expose unknown database errors or claim an uncertain write succeeded', async () => {
    mocks.reset.mockRejectedValue(new Error(`sensitive: ${password}`));
    const result = await resetMerchantPassword(previous, form());
    expect(result.done).toBe(false);
    expect(result.error).toContain('不要连续重复提交');
    expect(JSON.stringify(result)).not.toContain(password);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
