import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ member: vi.fn(), write: vi.fn() }));
vi.mock('../account/merchant-actions', () => ({ currentMerchantForWrite: mocks.member }));
vi.mock('./worker-writing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worker-writing')>()),
  requestWorkerWriting: mocks.write,
}));
import { POST } from '../[merchantId]/writing/generate/route';
const merchantId = 'aa'.repeat(16);
const origin = 'https://h5cs.1rying.com';
const payload = { field: 'welcomeMessage', currentText: '', brief: '亲切一点', consent: true };
function send(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(`${origin}/${merchantId}/writing/generate`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'x-h5cs-csrf': 'test-csrf',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ merchantId }) },
  );
}
describe('merchant writing authorization', () => {
  beforeEach(() => {
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', origin);
    vi.clearAllMocks();
    mocks.member.mockResolvedValue({ merchantId });
    mocks.write.mockResolvedValue({
      options: ['您好，欢迎提问。', '欢迎光临，请问需要什么帮助？'],
      reminders: [],
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('requires same-origin, primary membership and CSRF before sending any text', async () => {
    expect((await send(payload, { Origin: 'https://evil.invalid' })).status).toBe(403);
    expect(mocks.member).not.toHaveBeenCalled();
    mocks.member.mockResolvedValue(null);
    expect((await send(payload)).status).toBe(403);
    expect(mocks.member).toHaveBeenCalledWith(merchantId, 'test-csrf');
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('requires explicit consent and bounded text', async () => {
    for (const patch of [
      { consent: false },
      { consent: 'true' },
      { brief: '' },
      { brief: 'x'.repeat(1001) },
    ])
      expect((await send({ ...payload, ...patch })).status).toBe(400);
    expect((await send({ ...payload, brief: 'x'.repeat(25000) })).status).toBe(413);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('uses the authenticated route merchant, forwards only the selected field and never caches', async () => {
    const response = await send({
      ...payload,
      merchantId: 'bb'.repeat(16),
      secret: 'do-not-forward',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.write).toHaveBeenCalledWith(merchantId, {
      field: payload.field,
      brief: payload.brief,
      currentText: '',
    });
    expect(await response.text()).not.toContain('do-not-forward');
  });
  it('returns a friendly failure without provider error details', async () => {
    mocks.write.mockRejectedValue(new Error('sensitive provider detail'));
    const response = await send(payload);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('sensitive');
  });
});
