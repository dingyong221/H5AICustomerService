import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { collectUsageRequest } from '../src/usage-http.js';
vi.mock('../src/config.js', () => ({ loadDatabaseConfig: () => ({ configured: false }) }));
const origin = 'https://usage.test';
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(origin + '/usage', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
describe('collector rejects unsafe input and respects privacy', () => {
  beforeEach(() => vi.stubEnv('H5CS_GROWTH_USAGE_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());
  it('rejects foreign origins', async () => {
    expect(
      (await collectUsageRequest(request({}, { origin: 'https://other.test' }), origin)).status,
    ).toBe(403);
  });
  it('does not collect when browser privacy signal is present', async () => {
    const r = await collectUsageRequest(request({}, { 'sec-gpc': '1' }), origin);
    expect((await r.json()).reason).toBe('privacy');
  });
  it('rejects oversized bodies before parsing', async () => {
    expect(
      (await collectUsageRequest(request({ payload: 'x'.repeat(34000) }), origin)).status,
    ).toBe(413);
  });
  it('rejects claimed identities and sensitive fields', async () => {
    expect(
      (await collectUsageRequest(request({ events: [], merchantId: 'x' }), origin)).status,
    ).toBe(400);
  });
});
