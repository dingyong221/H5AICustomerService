import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ claim: vi.fn(), set: vi.fn(), origin: 'https://example.test' }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: mocks.origin }),
  cookies: async () => ({ set: mocks.set }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error('REDIRECT:' + path);
  },
}));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: () => ({ configured: true, config: {} }),
  selfServicePolicy: () => ({ days: null, modelCalls: null }),
  marketplaceFixtureEnabled: () => false,
  MerchantAccessError: class extends Error {},
  MySqlMerchantAccessRepository: class {},
  MarketplaceAccessError: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  MySqlMarketplaceRepository: class {
    claimFree = mocks.claim;
  },
}));
import { claimMarketplace } from './merchant-actions';
import { MarketplaceAccessError } from '@h5cs/database';

function registration() {
  const form = new FormData();
  form.set('merchantName', '合成测试商家');
  form.set('phone', '13800000000');
  form.set('password', 'synthetic-password-123');
  return form;
}
describe('简洁注册不依赖勾选，但保留服务端认证', () => {
  beforeEach(() => {
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', 'https://example.test');
    vi.stubEnv('MERCHANT_PHONE_LOOKUP_KEY', 'synthetic-test-only-key');
    mocks.origin = 'https://example.test';
    mocks.claim.mockReset();
    mocks.set.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());
  it('只提交账号资料即可开通，成功后进入唯一客服', async () => {
    mocks.claim.mockResolvedValue({
      merchantId: 'm',
      assistantId: 'a',
      sessionToken: 'session',
      csrfToken: 'csrf',
    });
    await expect(claimMarketplace({ error: null }, registration())).rejects.toThrow(
      'REDIRECT:/m/drafts/a',
    );
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({ reuseExisting: true, phone: '13800000000' }),
    );
    expect(mocks.set).toHaveBeenCalledTimes(2);
  });
  it('原密码错误仍拒绝，不能仅靠相同手机号进入原商家', async () => {
    mocks.claim.mockRejectedValue(new MarketplaceAccessError('authentication_failed'));
    const result = await claimMarketplace({ error: null }, registration());
    expect(result.error).toContain('原密码');
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('外站请求不能调用开通逻辑', async () => {
    mocks.origin = 'https://other.test';
    expect((await claimMarketplace({ error: null }, registration())).error).toContain('来源');
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it('缺少密码仍拒绝', async () => {
    const form = registration();
    form.delete('password');
    expect((await claimMarketplace({ error: null }, form)).error).toContain('完整');
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
