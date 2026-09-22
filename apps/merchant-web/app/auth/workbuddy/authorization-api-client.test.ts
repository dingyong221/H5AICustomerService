import { describe, expect, it, vi } from 'vitest';

import {
  createWorkBuddyAuthorizationApiClient,
  readWorkBuddyCsrfToken,
  WorkBuddyAuthorizationClientError,
} from './authorization-api-client';

const origin = 'https://merchant.example.com';
const transactionRef = 'a'.repeat(64);
const csrfToken = 'csrf_'.padEnd(48, 'x');
const requestId = 'request-auth-1234';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function successResponse(data: unknown): Response {
  return jsonResponse({ data, request_id: requestId });
}

function errorResponse(
  status: number,
  error: { code: string; message: string; retryable: boolean },
): Response {
  return jsonResponse({ error, request_id: requestId }, status);
}

function createClient(
  fetchImpl: typeof fetch,
  getCsrfToken: () => string | undefined = () => csrfToken,
) {
  return createWorkBuddyAuthorizationApiClient({
    apiBaseUrl: '/api/v1/',
    fetchImpl,
    getCsrfToken,
    origin,
  });
}

describe('WorkBuddy authorization API client', () => {
  it('reads only a bounded CSRF cookie value', () => {
    expect(readWorkBuddyCsrfToken(`other=value; h5cs_csrf=${csrfToken}`)).toBe(csrfToken);
    expect(readWorkBuddyCsrfToken(`__Host-h5cs-csrf=${csrfToken}`)).toBe(csrfToken);
    expect(readWorkBuddyCsrfToken('h5cs_csrf=short')).toBeUndefined();
    expect(readWorkBuddyCsrfToken('session=opaque')).toBeUndefined();
  });

  it('reads trusted status with credentials and an exact transaction pointer', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        successResponse({ status: 'consent_required', transaction_ref: transactionRef }),
      );
    const result = await createClient(fetchMock).readStatus(transactionRef);

    expect(result).toEqual({ status: 'consent_required', transaction_ref: transactionRef });
    const [endpoint, request] = fetchMock.mock.calls[0] ?? [];
    if (endpoint === undefined) throw new Error('Expected status request');
    expect(endpoint.toString()).toBe(
      `https://merchant.example.com/api/v1/auth/workbuddy/status?transaction_ref=${transactionRef}`,
    );
    expect(request).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'GET',
      redirect: 'error',
    });
  });

  it('forwards callback material only to the server callback endpoint', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        successResponse({ status: 'consent_required', transaction_ref: transactionRef }),
      );
    await createClient(fetchMock).completeCallback({
      code: 'one-time-code',
      state: 's'.repeat(32),
    });

    const [endpoint, request] = fetchMock.mock.calls[0] ?? [];
    if (endpoint === undefined) throw new Error('Expected callback request');
    expect(endpoint.toString()).toBe(
      `https://merchant.example.com/api/v1/auth/workbuddy/callback?code=one-time-code&state=${'s'.repeat(32)}`,
    );
    expect(new Headers(request?.headers).has('x-csrf-token')).toBe(false);
  });

  it('starts authorization with same-origin credentials and explicit CSRF', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successResponse({
        authorization_url: 'https://www.workbuddy.cn/openapi/v2/oauth/authorize?state=opaque-state',
        status: 'signed_in',
        transaction_ref: transactionRef,
      }),
    );

    await createClient(fetchMock).startAuthorization();

    const [endpoint, request] = fetchMock.mock.calls[0] ?? [];
    if (endpoint === undefined) throw new Error('Expected authorization request');
    expect(endpoint.toString()).toBe(
      'https://merchant.example.com/api/v1/auth/workbuddy/authorizations',
    );
    expect(request).toMatchObject({ body: '{}', credentials: 'same-origin', method: 'POST' });
    expect(new Headers(request?.headers).get('x-csrf-token')).toBe(csrfToken);
  });

  it('posts exact transaction-scoped selection and consent with explicit CSRF', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({ status: 'consent_required', transaction_ref: transactionRef }),
      )
      .mockResolvedValueOnce(successResponse({ status: 'connected' }));
    const client = createClient(fetchMock);

    await client.selectMerchant({ candidateRef: 'candidate_one', transactionRef });
    await client.recordConsent({ decision: 'grant', transactionRef });

    const [, selectionRequest] = fetchMock.mock.calls[0] ?? [];
    const [, consentRequest] = fetchMock.mock.calls[1] ?? [];
    expect(selectionRequest).toMatchObject({
      body: JSON.stringify({
        candidate_ref: 'candidate_one',
        transaction_ref: transactionRef,
      }),
      credentials: 'same-origin',
      method: 'POST',
    });
    expect(new Headers(selectionRequest?.headers).get('x-csrf-token')).toBe(csrfToken);
    expect(consentRequest?.body).toBe(
      JSON.stringify({ decision: 'grant', transaction_ref: transactionRef }),
    );
    expect(new Headers(consentRequest?.headers).get('x-csrf-token')).toBe(csrfToken);
  });

  it('fails closed before a mutation when CSRF context is missing', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createClient(fetchMock, () => undefined);

    await expect(client.startAuthorization()).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(client.recordConsent({ decision: 'grant', transactionRef })).rejects.toMatchObject(
      { kind: 'forbidden' },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects cross-origin configuration and malformed server success responses', async () => {
    expect(() =>
      createWorkBuddyAuthorizationApiClient({
        apiBaseUrl: 'https://api.example.com/api/v1/',
        getCsrfToken: () => csrfToken,
        origin,
      }),
    ).toThrow(WorkBuddyAuthorizationClientError);

    const client = createClient(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          successResponse({ status: 'consent_required', transaction_ref: 'caller-controlled' }),
        ),
    );
    await expect(client.readStatus()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('keeps an unavailable runtime explicit and retryable', async () => {
    const client = createClient(
      vi.fn<typeof fetch>().mockResolvedValue(
        errorResponse(503, {
          code: 'SERVICE_UNAVAILABLE',
          message: 'WorkBuddy authorization is unavailable',
          retryable: true,
        }),
      ),
    );

    await expect(client.readStatus()).rejects.toMatchObject({
      kind: 'unavailable',
      requestId,
      retryable: true,
    });
  });

  it('rejects bare success data and does not trust a top-level error code', async () => {
    await expect(
      createClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            jsonResponse({ status: 'consent_required', transaction_ref: transactionRef }),
          ),
      ).readStatus(),
    ).rejects.toMatchObject({ kind: 'invalid_response' });

    await expect(
      createClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            jsonResponse(
              { code: 'FORBIDDEN', message: 'not an error envelope', retryable: false },
              500,
            ),
          ),
      ).readStatus(),
    ).rejects.toMatchObject({ kind: 'unavailable', requestId: undefined, retryable: true });
  });
});
