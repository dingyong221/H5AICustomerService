import { describe, expect, it, vi } from 'vitest';

import { createOnboardingApiClient, OnboardingClientError } from './onboarding-api-client';

const sessionId = '33333333333333333333333333333333';

const successResponse = () =>
  new Response(
    JSON.stringify({
      data: {
        action: 'continue_onboarding',
        missing_items: [],
        onboarding_session_id: sessionId,
        state: 'industry',
      },
      request_id: 'request-1234',
    }),
    { headers: { 'Content-Type': 'application/json' }, status: 200 },
  );

describe('onboarding API client boundary', () => {
  it('does not issue a request when the API is not configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createOnboardingApiClient({
      fetchImpl,
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });

    await expect(client.startOrResume({ idempotencyKey: 'request-key' })).rejects.toMatchObject({
      kind: 'not_configured',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects cross-origin API configuration before reading credentials or sending', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const getAccessToken = vi.fn(() => 'token');
    const client = createOnboardingApiClient({
      apiBaseUrl: 'https://foreign.test/api/v1/skill',
      fetchImpl,
      getAccessToken,
      origin: 'https://merchant.test',
    });

    await expect(client.startOrResume({ idempotencyKey: 'request-key' })).rejects.toMatchObject({
      kind: 'unsafe_configuration',
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not issue a request when no in-memory access token exists', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl,
      getAccessToken: () => undefined,
      origin: 'https://merchant.test',
    });

    await expect(client.startOrResume({ idempotencyKey: 'request-key' })).rejects.toMatchObject({
      kind: 'authentication_required',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the real intent route and keeps Bearer data out of the URL and body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => successResponse());
    const client = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl,
      getAccessToken: () => 'short-lived-token',
      origin: 'https://merchant.test',
    });

    await expect(client.startOrResume({ idempotencyKey: 'reserved-key' })).resolves.toMatchObject({
      state: 'industry',
    });
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    const url = String(input);
    const headers = new Headers(init?.headers);
    expect(url).toBe('https://merchant.test/api/v1/skill/intents');
    expect(url).not.toContain('short-lived-token');
    expect(String(init?.body)).not.toContain('short-lived-token');
    expect(headers.get('Authorization')).toBe('Bearer short-lived-token');
    expect(headers.get('Idempotency-Key')).toBe('reserved-key');
  });

  it('uses the real onboarding event route and shared request schema', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => successResponse());
    const client = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl,
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });

    await client.advance({
      event: { industryCode: 'retail', type: 'provide_industry' },
      idempotencyKey: 'reserved-key',
      sessionId,
    });
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(input)).toBe(`https://merchant.test/api/v1/skill/onboarding/${sessionId}/events`);
    expect(JSON.parse(String(init?.body))).toEqual({
      event: { industryCode: 'retail', type: 'provide_industry' },
    });
  });

  it('accepts a same-origin existing assistant management link without starting onboarding', async () => {
    const client = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                action: 'open_management_console',
                assistant: {
                  assistant_ref: '44444444444444444444444444444444',
                  status: 'active',
                },
                url: 'https://merchant.test/workspace',
              },
              request_id: 'request-existing',
            }),
            { status: 200 },
          ),
      ),
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });

    await expect(client.startOrResume({ idempotencyKey: 'reserved-key' })).resolves.toEqual({
      action: 'open_management_console',
      assistant: { assistant_ref: '44444444444444444444444444444444', status: 'active' },
      url: 'https://merchant.test/workspace',
    });
  });

  it('rejects cross-origin or embellished management links', async () => {
    for (const url of [
      'https://foreign.test/workspace',
      'https://merchant.test/workspace?token=secret',
      'https://merchant.test/workspace#secret',
    ]) {
      const client = createOnboardingApiClient({
        apiBaseUrl: '/api/v1/skill',
        fetchImpl: vi.fn<typeof fetch>(
          async () =>
            new Response(
              JSON.stringify({
                data: {
                  action: 'open_management_console',
                  assistant: {
                    assistant_ref: '44444444444444444444444444444444',
                    status: 'active',
                  },
                  url,
                },
                request_id: 'request-unsafe-link',
              }),
              { status: 200 },
            ),
        ),
        getAccessToken: () => 'token',
        origin: 'https://merchant.test',
      });

      await expect(client.startOrResume({ idempotencyKey: 'reserved-key' })).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    }
  });

  it('accepts a multi-assistant selection only with exact assistant summaries', async () => {
    const client = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                action: 'select_assistant',
                assistants: [
                  { assistant_ref: '44444444444444444444444444444444', status: 'active' },
                  { assistant_ref: '55555555555555555555555555555555', status: 'paused' },
                ],
                selection_required: true,
                url: 'https://merchant.test/workspace',
              },
              request_id: 'request-selection',
            }),
            { status: 200 },
          ),
      ),
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });

    await expect(client.startOrResume({ idempotencyKey: 'reserved-key' })).resolves.toMatchObject({
      action: 'select_assistant',
      selection_required: true,
    });
  });

  it('maps validated conflicts and invalid error bodies without trusting them', async () => {
    const conflictFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'VERSION_CONFLICT', message: 'stale', retryable: false },
            request_id: 'request-conflict',
          }),
          { status: 409 },
        ),
    );
    const conflictClient = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl: conflictFetch,
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });

    await expect(
      conflictClient.startOrResume({ idempotencyKey: 'reserved-key' }),
    ).rejects.toMatchObject({ kind: 'conflict', requestId: 'request-conflict' });

    const invalidClient = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl: vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ error: 'not-an-envelope' }), { status: 500 }),
      ),
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });
    await expect(
      invalidClient.startOrResume({ idempotencyKey: 'reserved-key' }),
    ).rejects.toMatchObject({ kind: 'request_failed', requestId: undefined });
  });

  it('rejects unknown fields in success and error envelopes instead of stripping them', async () => {
    const successClient = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                action: 'continue_onboarding',
                internal: 'must-not-be-trusted',
                missing_items: [],
                onboarding_session_id: sessionId,
                state: 'industry',
              },
              request_id: 'request-extra-success',
            }),
            { status: 200 },
          ),
      ),
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });
    await expect(
      successClient.startOrResume({ idempotencyKey: 'reserved-key' }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });

    const errorClient = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'VERSION_CONFLICT',
                internal: 'must-not-be-trusted',
                message: 'stale',
                retryable: false,
              },
              request_id: 'request-extra-error',
            }),
            { status: 409 },
          ),
      ),
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });
    await expect(
      errorClient.startOrResume({ idempotencyKey: 'reserved-key' }),
    ).rejects.toMatchObject({ kind: 'request_failed', requestId: undefined });
  });

  it('keeps binding, merchant selection and generation availability distinct from conflicts', async () => {
    const cases = [
      ['BINDING_REQUIRED', 'binding_required'],
      ['MERCHANT_SELECTION_REQUIRED', 'merchant_selection_required'],
      ['GENERATION_UNAVAILABLE', 'generation_unavailable'],
    ] as const;

    for (const [code, kind] of cases) {
      const client = createOnboardingApiClient({
        apiBaseUrl: '/api/v1/skill',
        fetchImpl: vi.fn<typeof fetch>(
          async () =>
            new Response(
              JSON.stringify({
                error: { code, message: 'safe error', retryable: false },
                request_id: `request-${code.toLowerCase()}`,
              }),
              { status: code === 'GENERATION_UNAVAILABLE' ? 503 : 409 },
            ),
        ),
        getAccessToken: () => 'token',
        origin: 'https://merchant.test',
      });
      await expect(client.startOrResume({ idempotencyKey: 'reserved-key' })).rejects.toMatchObject({
        kind,
      });
    }

    const genericConflict = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'BAD_REQUEST', message: 'not a version conflict', retryable: false },
              request_id: 'request-generic-409',
            }),
            { status: 409 },
          ),
      ),
      getAccessToken: () => 'token',
      origin: 'https://merchant.test',
    });
    await expect(
      genericConflict.startOrResume({ idempotencyKey: 'reserved-key' }),
    ).rejects.toMatchObject({ kind: 'request_failed' });
  });

  it('reports authentication expiry and triggers in-memory credential clearing', async () => {
    const onAuthenticationExpired = vi.fn();
    const client = createOnboardingApiClient({
      apiBaseUrl: '/api/v1/skill',
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'UNAUTHORIZED', message: 'expired', retryable: false },
              request_id: 'request-auth',
            }),
            { status: 401 },
          ),
      ),
      getAccessToken: () => 'expired-token',
      onAuthenticationExpired,
      origin: 'https://merchant.test',
    });

    await expect(client.startOrResume({ idempotencyKey: 'reserved-key' })).rejects.toBeInstanceOf(
      OnboardingClientError,
    );
    expect(onAuthenticationExpired).toHaveBeenCalledOnce();
  });
});
