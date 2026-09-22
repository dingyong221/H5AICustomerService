import { describe, expect, it, vi } from 'vitest';

import { snapshotFixture } from './assistant-management-test-fixture';
import {
  AssistantManagementClientError,
  createAssistantManagementApiClient,
} from './assistant-management-api-client';

const origin = 'https://merchant.example.com';
const csrfToken = 'csrf_'.padEnd(48, 'x');
const idempotencyKey = 'command_01'.padEnd(32, 'x');
const requestId = 'request-assistant-1234';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function successResponse(data: unknown, status = 200): Response {
  return response({ data, request_id: requestId }, status);
}

function errorResponse(status: 403 | 404 | 409 | 503): Response {
  const code = {
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    503: 'SERVICE_UNAVAILABLE',
  }[status];
  return response(
    {
      error: { code, message: 'request failed', retryable: status === 503 },
      request_id: requestId,
    },
    status,
  );
}

function client(fetchImpl: typeof fetch, getCsrfToken: () => string | undefined = () => csrfToken) {
  return createAssistantManagementApiClient({
    apiBaseUrl: '/api/v1/',
    assistantRef: 'assistant_01',
    fetchImpl,
    getCsrfToken,
    origin,
  });
}

describe('assistant management API client', () => {
  it('loads only the path-scoped assistant snapshot with same-origin cookies', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(snapshotFixture));
    await expect(client(fetchMock).loadSnapshot()).resolves.toMatchObject({
      assistantRef: 'assistant_01',
    });

    const [endpoint, request] = fetchMock.mock.calls[0] ?? [];
    if (endpoint === undefined) throw new Error('Expected draft request');
    expect(endpoint.toString()).toBe(
      'https://merchant.example.com/api/v1/merchant/assistants/assistant_01/draft',
    );
    expect(request).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'GET',
      redirect: 'error',
    });
  });

  it('saves the draft with CSRF, one idempotency key, and the exact ETag', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successResponse({
        ...snapshotFixture,
        draft: { ...snapshotFixture.draft, revision: 4 },
        etag: '"draft-4"',
      }),
    );
    const draft = {
      assistantName: '小蓝客服',
      businessScope: '空调清洗服务咨询',
      insufficientInfoMessage: '当前资料不足，请联系商家确认。',
      welcomeMessage: '你好，我是小蓝 AI 客服。',
    };
    await client(fetchMock).saveDraft({
      draft,
      etag: snapshotFixture.etag,
      idempotencyKey,
    });

    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request).toMatchObject({ body: JSON.stringify(draft), method: 'PATCH' });
    const headers = new Headers(request?.headers);
    expect(headers.get('If-Match')).toBe('"draft-3"');
    expect(headers.get('Idempotency-Key')).toBe(idempotencyKey);
    expect(headers.get('x-csrf-token')).toBe(csrfToken);
  });

  it('starts a confirmed release without accepting its future public URL early', async () => {
    const accepted = {
      operationId: 'operation_01',
      pollUrl: '/api/v1/merchant/operations/operation_01',
      releaseId: 'release_01',
      state: 'accepted',
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(accepted, 202));
    await expect(
      client(fetchMock).startRelease({
        draftRevision: 3,
        etag: snapshotFixture.etag,
        idempotencyKey,
      }),
    ).resolves.toEqual(accepted);

    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.body).toBe(JSON.stringify({ activateWhenReady: true, draftRevision: 3 }));
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe(idempotencyKey);
  });

  it('ignores the returned poll URL and polls only the fixed operation path', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successResponse({
        operationId: 'operation_01',
        result: {
          publicUrl: '/a/xiaolan-service',
          releaseId: 'release_01',
          releaseNo: 1,
        },
        state: 'succeeded',
      }),
    );
    await client(fetchMock).readOperation('operation_01');

    const [endpoint] = fetchMock.mock.calls[0] ?? [];
    if (endpoint === undefined) throw new Error('Expected operation request');
    expect(endpoint.toString()).toBe(
      'https://merchant.example.com/api/v1/merchant/operations/operation_01',
    );
  });

  it('rejects an external poll URL and a response for another assistant', async () => {
    const externalPoll = client(
      vi.fn<typeof fetch>().mockResolvedValue(
        successResponse(
          {
            operationId: 'operation_01',
            pollUrl: 'https://evil.example/steal',
            releaseId: 'release_01',
            state: 'accepted',
          },
          202,
        ),
      ),
    );
    await expect(
      externalPoll.startRelease({
        draftRevision: 3,
        etag: snapshotFixture.etag,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });

    const wrongAssistant = client(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          successResponse({ ...snapshotFixture, assistantRef: 'assistant_other' }),
        ),
    );
    await expect(wrongAssistant.loadSnapshot()).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('fails before any write when CSRF, ETag, idempotency, or same-origin config is invalid', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      client(fetchMock, () => undefined).saveDraft({
        draft: {
          assistantName: '小蓝客服',
          businessScope: '空调清洗服务咨询',
          insufficientInfoMessage: '资料不足',
          welcomeMessage: '你好',
        },
        etag: snapshotFixture.etag,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      client(fetchMock).saveDraft({
        draft: {
          assistantName: '',
          businessScope: '空调清洗服务咨询',
          insufficientInfoMessage: '资料不足',
          welcomeMessage: '你好',
        },
        etag: snapshotFixture.etag,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();

    expect(() =>
      createAssistantManagementApiClient({
        apiBaseUrl: 'https://api.example.com/api/v1/',
        assistantRef: 'assistant_01',
        getCsrfToken: () => csrfToken,
        origin,
      }),
    ).toThrow(AssistantManagementClientError);
  });

  it.each([
    [404, 'not_found'],
    [403, 'forbidden'],
    [409, 'conflict'],
    [503, 'unavailable'],
  ] as const)('maps HTTP %i to a fail-closed %s state', async (status, kind) => {
    const api = client(vi.fn<typeof fetch>().mockResolvedValue(errorResponse(status)));
    await expect(api.loadSnapshot()).rejects.toMatchObject({ kind, requestId });
  });
});
