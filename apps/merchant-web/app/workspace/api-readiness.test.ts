import { describe, expect, it, vi } from 'vitest';

import { publicApiReady } from './api-readiness';

const readyResponse = () =>
  new Response(
    JSON.stringify({
      data: {
        status: 'ready',
        service: 'api',
        checks: { database: { status: 'up' }, conversation: { status: 'up' } },
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

describe('public API publication readiness', () => {
  it('requires the internal API to report both database and conversation ready', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => readyResponse());
    await expect(
      publicApiReady(
        { NODE_ENV: 'production', API_READINESS_URL: 'http://api:4000/readyz' },
        fetchImpl,
      ),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api:4000/readyz',
      expect.objectContaining({ cache: 'no-store', redirect: 'error' }),
    );
    const disabled = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              status: 'ready',
              service: 'api',
              checks: { database: { status: 'up' }, conversation: { status: 'unconfigured' } },
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );
    await expect(
      publicApiReady(
        { NODE_ENV: 'production', API_READINESS_URL: 'http://api:4000/readyz' },
        disabled,
      ),
    ).resolves.toBe(false);
  });

  it('rejects unsafe or missing readiness addresses before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const url of [undefined, 'http://evil.example/readyz', 'http://api:4000/readyz?x=1']) {
      await expect(
        publicApiReady({ NODE_ENV: 'production', API_READINESS_URL: url }, fetchImpl),
      ).resolves.toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
