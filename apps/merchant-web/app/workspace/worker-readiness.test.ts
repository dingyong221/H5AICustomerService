import { describe, expect, it, vi } from 'vitest';

import { workerReady } from './worker-readiness';

const production = {
  NODE_ENV: 'production',
  WORKER_READINESS_URL: 'http://worker:3011/readyz',
} satisfies NodeJS.ProcessEnv;

const response = (conversation: string, status = 200): Response =>
  new Response(
    JSON.stringify({
      data: {
        status: conversation === 'up' ? 'ready' : 'not_ready',
        service: 'worker',
        checks: { database: { status: 'up' }, conversation: { status: conversation } },
      },
      request_id: 'request_1234567890',
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );

describe('merchant publication Worker gate', () => {
  it('accepts only the internal production Worker readiness endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response('up'));
    await expect(workerReady(production, fetchImpl)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://worker:3011/readyz',
      expect.objectContaining({ cache: 'no-store', redirect: 'error' }),
    );
    for (const url of [
      'http://127.0.0.1:3011/readyz',
      'http://worker:3011/admin',
      'http://worker:3012/readyz',
      'https://evil.example/readyz',
    ]) {
      await expect(
        workerReady({ ...production, WORKER_READINESS_URL: url }, fetchImpl),
      ).resolves.toBe(false);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks publishing on a degraded, failed, or malformed readiness response', async () => {
    for (const result of [
      response('unconfigured', 503),
      new Response(JSON.stringify({ data: { status: 'ready', service: 'worker' } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
      new Response('not json', { headers: { 'Content-Type': 'text/plain' } }),
    ]) {
      await expect(
        workerReady(
          production,
          vi.fn<typeof fetch>(async () => result),
        ),
      ).resolves.toBe(false);
    }
  });
});
