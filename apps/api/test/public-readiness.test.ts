import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@h5cs/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@h5cs/database')>();
  return {
    ...actual,
    loadDatabaseConfig: () => ({
      configured: true,
      config: {
        openConnection: async () => {
          throw new Error('readiness must not open a second connection');
        },
        summary: { host: 'test', database: 'test', tlsRequested: false },
        toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
      },
    }),
    probeDatabase: async () => ({ ok: true, latencyMs: 1 }),
  };
});

import { HealthService } from '../src/health.service.js';

afterEach(() => vi.unstubAllEnvs());

describe('public conversation readiness', () => {
  it('reports ready only when the public session and turn services have credentials', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PUBLIC_CONVERSATION_ENABLED', 'true');
    vi.stubEnv('CONSUMER_H5_ORIGIN', 'https://h5cs.1rying.com');
    vi.stubEnv('VISITOR_CREDENTIAL_HMAC_KEY', 'A'.repeat(43));
    const ready = await new HealthService().readiness();
    expect(ready).toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' }, conversation: { status: 'up' } },
    });

    vi.stubEnv('VISITOR_CREDENTIAL_HMAC_KEY', undefined);
    const missingCredential = await new HealthService().readiness();
    expect(missingCredential).toMatchObject({
      status: 'not_ready',
      checks: { database: { status: 'up' }, conversation: { status: 'unconfigured' } },
    });

    vi.stubEnv('PUBLIC_CONVERSATION_ENABLED', 'false');
    const disabled = await new HealthService().readiness();
    expect(disabled).toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' }, conversation: { status: 'unconfigured' } },
    });
  });
});
