import { describe, expect, it, vi } from 'vitest';

import {
  createPublicAssistantApiClient,
  decodeAcceptedTurn,
  decodePublicApiErrorEnvelope,
  decodePublicAssistantSnapshot,
  decodeTurnResult,
  type OnlinePublicAssistantSnapshot,
} from './public-api-client';

const origin = 'https://h5.example.com';

function envelope(data: Readonly<Record<string, unknown>>): unknown {
  return { data, request_id: 'request_1234567890' };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

const snapshotData = {
  aiDisclosure: true,
  assistantDisplayName: '售前助手',
  availability: 'online',
  businessScope: '仅回答商品与订单问题',
  merchantDisplayName: '示例商家',
  publicAssistantId: 'assistant_public_1',
  releaseRef: 'release_1234567890',
  welcomeMessage: '你好，请问想了解什么？',
} as const;

const snapshot: OnlinePublicAssistantSnapshot = snapshotData;

describe('public API response decoders', () => {
  it('accepts an exact online public snapshot', () => {
    expect(decodePublicAssistantSnapshot(envelope(snapshotData))).toEqual(snapshotData);
    expect(decodePublicAssistantSnapshot(envelope({
      ...snapshotData,
      assistantDisplayName: '客'.repeat(200),
    }))).toBeDefined();
    expect(decodePublicAssistantSnapshot(envelope({
      ...snapshotData,
      assistantDisplayName: '客'.repeat(201),
    }))).toBeUndefined();
    expect(decodePublicAssistantSnapshot(envelope({
      ...snapshotData,
      businessScope: '服务 A\n服务 B',
    }))?.businessScope).toBe('服务 A\n服务 B');
  });

  it('accepts the shared request ID grammar including dots and rejects short IDs', () => {
    expect(decodePublicAssistantSnapshot({ data: snapshotData, request_id: 'req.1234' })).toEqual(
      snapshotData,
    );
    expect(
      decodePublicAssistantSnapshot({ data: snapshotData, request_id: 'short' }),
    ).toBeUndefined();
  });

  it('rejects extra fields and a missing AI disclosure', () => {
    expect(
      decodePublicAssistantSnapshot(envelope({ ...snapshotData, internalMerchantId: 'secret' })),
    ).toBeUndefined();
    expect(
      decodePublicAssistantSnapshot(envelope({ ...snapshotData, aiDisclosure: false })),
    ).toBeUndefined();
  });

  it('rejects cross-origin accepted-turn URLs', () => {
    expect(
      decodeAcceptedTurn(
        envelope({
          eventsUrl: '/api/v1/public/sessions/session_1234567890/turns/turn_1/events',
          resultUrl: 'https://evil.example/api/v1/public/turns/turn_1',
          state: 'accepted',
          traceId: 'trace_1234567890',
          turnId: 'turn_1234567890',
        }),
        origin,
      ),
    ).toBeUndefined();
  });

  it('rejects same-origin turn URLs outside the exact session and turn route', () => {
    expect(
      decodeAcceptedTurn(
        envelope({
          eventsUrl: '/api/v1/public/health/turn_1234567890/events',
          resultUrl: '/api/v1/public/health/turn_1234567890',
          state: 'accepted',
          traceId: 'trace_1234567890',
          turnId: 'turn_1234567890',
        }),
        origin,
      ),
    ).toBeUndefined();
    expect(
      decodeAcceptedTurn(
        envelope({
          eventsUrl: '/api/v1/public/sessions/session_other_1234/turns/turn_1234567890/events',
          resultUrl: '/api/v1/public/sessions/session_1234567890/turns/turn_1234567890',
          state: 'accepted',
          traceId: 'trace_1234567890',
          turnId: 'turn_1234567890',
        }),
        origin,
      ),
    ).toBeUndefined();
  });

  it('strictly decodes standard error envelopes without trusting extra fields', () => {
    expect(
      decodePublicApiErrorEnvelope({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'unavailable', retryable: true },
        request_id: 'request_1234567890',
      }),
    ).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      requestId: 'request_1234567890',
      retryable: true,
    });
    expect(
      decodePublicApiErrorEnvelope({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          internal: 'must-not-be-trusted',
          message: 'unavailable',
          retryable: true,
        },
        request_id: 'request_1234567890',
      }),
    ).toBeUndefined();
  });

  it('requires strictly increasing, unique server message sequences', () => {
    const result = envelope({
      messages: [
        {
          clientMessageId: 'message_1234567890',
          content: '问题',
          createdAt: '2026-09-21T08:00:00.000Z',
          messageId: 'server_message_1',
          role: 'visitor',
          sequence: 2,
        },
        {
          content: '回答',
          createdAt: '2026-09-21T08:00:01.000Z',
          messageId: 'server_message_2',
          role: 'assistant',
          sequence: 1,
          sourceLabel: 'AI 客服',
        },
      ],
      sessionHandle: 'session_1234567890',
      state: 'completed',
      traceId: 'trace_1234567890',
      turnId: 'turn_1234567890',
    });
    expect(decodeTurnResult(result)).toBeUndefined();
  });
});

describe('public assistant API client', () => {
  it('fails closed for unknown, paused, malformed, and unavailable snapshots', async () => {
    const responses = [
      jsonResponse({}, 404),
      jsonResponse(envelope({ ...snapshotData, availability: 'paused' })),
      jsonResponse(envelope({ ...snapshotData, extra: true })),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl,
      origin,
    });

    await expect(client.loadAssistant('missing')).resolves.toEqual({
      reason: 'not_available',
      status: 'unavailable',
    });
    await expect(client.loadAssistant('paused')).resolves.toEqual({
      reason: 'paused',
      status: 'unavailable',
    });
    await expect(client.loadAssistant('malformed')).resolves.toEqual({
      reason: 'invalid_response',
      status: 'unavailable',
    });

    const unavailableClient = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError('network down');
      }),
      origin,
    });
    await expect(unavailableClient.loadAssistant('valid-slug')).resolves.toEqual({
      reason: 'api_unavailable',
      status: 'unavailable',
    });
  });

  it('uses the client message ID as the request idempotency key', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          envelope({
            createdAt: '2026-09-21T08:00:00.000Z',
            releaseRef: snapshot.releaseRef,
            sessionHandle: 'session_1234567890',
            state: 'active',
          }),
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          envelope({
            eventsUrl: '/api/v1/public/sessions/session_1234567890/turns/turn_1234567890/events',
            resultUrl: '/api/v1/public/sessions/session_1234567890/turns/turn_1234567890',
            state: 'accepted',
            traceId: 'trace_1234567890',
            turnId: 'turn_1234567890',
          }),
          202,
        ),
      );
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl,
      origin,
    });
    const session = await client.createSession({
      publicSlug: 'shop-help',
      sessionRequestId: 'session_request_1234567890',
      snapshot,
    });
    const [, sessionRequest] = fetchImpl.mock.calls[0]!;
    expect(sessionRequest?.body).toBeUndefined();
    expect(sessionRequest?.headers).toMatchObject({
      'Idempotency-Key': 'session_request_1234567890',
    });
    const clientMessageId = 'message_client_1234567890';
    await client.sendMessage({
      clientMessageId,
      content: '  请问多久发货？  ',
      sessionHandle: session.sessionHandle,
    });

    const [, request] = fetchImpl.mock.calls[1]!;
    expect(request?.headers).toMatchObject({ 'Idempotency-Key': clientMessageId });
    expect(JSON.parse(String(request?.body))).toEqual({
      clientMessageId,
      content: '请问多久发货？',
    });
  });

  it('refuses an API base on a different origin or insecure public origin', () => {
    expect(() =>
      createPublicAssistantApiClient({
        apiBaseUrl: 'https://api.example.com/api/v1/public',
        origin,
      }),
    ).toThrow('同源');
    expect(() =>
      createPublicAssistantApiClient({
        apiBaseUrl: '/api/v1/public',
        origin: 'http://h5.example.com',
      }),
    ).toThrow('同源');
  });

  it('rejects unsafe public slugs and a mismatched turn URL before fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl,
      origin,
    });

    await expect(client.loadAssistant('UPPER_case')).resolves.toEqual({
      reason: 'not_available',
      status: 'unavailable',
    });
    await expect(
      client.readTurn({
        clientMessageId: 'message_client_1234567890',
        resultUrl: '/api/v1/public/sessions/session_other_1234/turns/turn_1234567890',
        sessionHandle: 'session_1234567890',
        turnId: 'turn_1234567890',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves retryability and request ID only from a strict error envelope', async () => {
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: { code: 'SERVICE_UNAVAILABLE', message: 'unavailable', retryable: true },
            request_id: 'request_1234567890',
          },
          503,
        ),
      ),
      origin,
    });

    await expect(
      client.createSession({
        publicSlug: 'shop-help',
        sessionRequestId: 'session_request_1234567890',
        snapshot,
      }),
    ).rejects.toMatchObject({ requestId: 'request_1234567890', retryable: true });
  });
});
