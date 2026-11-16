import { describe, expect, it, vi } from 'vitest';

import {
  createPublicAssistantApiClient,
  decodeAcceptedTurn,
  decodePublicApiErrorEnvelope,
  decodePublicAssistantSnapshot,
  decodePublicSession,
  decodePublicSessionHistory,
  decodeTurnResult,
  type OnlinePublicAssistantSnapshot,
  publicExecutionState,
} from './public-api-client';

const origin = 'https://h5.example.com';
const sessionRequestId = `session_request_${'11'.repeat(16)}`;
const sessionHandle = `s_${'22'.repeat(16)}`;
const otherSessionHandle = `s_${'33'.repeat(16)}`;

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
  humanContact: '',
} as const;

const snapshot: OnlinePublicAssistantSnapshot = snapshotData;

describe('public API response decoders', () => {
  it('preserves MODEL_RESULT_UNKNOWN through the durable public result decoder', () => {
    expect(
      decodeTurnResult(
        envelope({
          sessionHandle,
          turnId: 'turn_unknown_1234',
          traceId: 'trace_unknown_1234',
          state: 'failed',
          messages: [],
          error: { code: 'MODEL_RESULT_UNKNOWN', retryable: false },
        }),
      ),
    ).toMatchObject({
      state: 'failed',
      error: { code: 'MODEL_RESULT_UNKNOWN', retryable: false },
    });
  });
  it('accepts an exact online public snapshot', () => {
    expect(decodePublicAssistantSnapshot(envelope(snapshotData))).toEqual(snapshotData);
    expect(
      decodePublicAssistantSnapshot(
        envelope({
          ...snapshotData,
          assistantDisplayName: '客'.repeat(200),
        }),
      ),
    ).toBeDefined();
    expect(
      decodePublicAssistantSnapshot(
        envelope({
          ...snapshotData,
          assistantDisplayName: '客'.repeat(201),
        }),
      ),
    ).toBeUndefined();
    expect(
      decodePublicAssistantSnapshot(
        envelope({
          ...snapshotData,
          businessScope: '服务 A\n服务 B',
        }),
      )?.businessScope,
    ).toBe('服务 A\n服务 B');
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

  it('reads optional legacy or published contact text without accepting HTML or oversized instructions', () => {
    const legacy = { ...snapshotData };
    Reflect.deleteProperty(legacy, 'humanContact');
    expect(decodePublicAssistantSnapshot(envelope(legacy))?.humanContact).toBe('');
    expect(
      decodePublicAssistantSnapshot(
        envelope({ ...snapshotData, humanContact: '工作日9—18点\n微信 shop_service' }),
      )?.humanContact,
    ).toBe('工作日9—18点\n微信 shop_service');
    for (const humanContact of [
      '联'.repeat(501),
      '<a href="https://evil.example">人工</a>',
      '电话\u0000隐藏',
      null,
    ]) {
      expect(
        decodePublicAssistantSnapshot(envelope({ ...snapshotData, humanContact })),
      ).toBeUndefined();
    }
  });

  it('rejects cross-origin accepted-turn URLs', () => {
    expect(
      decodeAcceptedTurn(
        envelope({
          eventsUrl: `/api/v1/public/sessions/${sessionHandle}/turns/turn_1/events`,
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
          eventsUrl: `/api/v1/public/sessions/${otherSessionHandle}/turns/turn_1234567890/events`,
          resultUrl: `/api/v1/public/sessions/${sessionHandle}/turns/turn_1234567890`,
          state: 'accepted',
          traceId: 'trace_1234567890',
          turnId: 'turn_1234567890',
        }),
        origin,
      ),
    ).toBeUndefined();
  });

  it('rejects a session credential embedded in a handle or polling URL', () => {
    const bearerHandle = `${sessionHandle}_${'A'.repeat(43)}`;
    expect(
      decodePublicSession(
        envelope({
          createdAt: '2026-09-21T08:00:00.000Z',
          releaseRef: snapshot.releaseRef,
          sessionHandle: bearerHandle,
          state: 'active',
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeAcceptedTurn(
        envelope({
          eventsUrl: `/api/v1/public/sessions/${bearerHandle}/turns/turn_1234567890/events`,
          resultUrl: `/api/v1/public/sessions/${bearerHandle}/turns/turn_1234567890`,
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
      sessionHandle,
      state: 'completed',
      traceId: 'trace_1234567890',
      turnId: 'turn_1234567890',
    });
    expect(decodeTurnResult(result)).toBeUndefined();
  });

  it('accepts pinned session history and rejects a mismatched active turn', () => {
    const history = {
      activeTurn: {
        clientMessageId: 'message_1234567890',
        content: '多少钱？',
        turnId: 'turn_1234567890',
      },
      createdAt: '2026-09-21T08:00:00.000Z',
      hasEarlierMessages: false,
      messages: [
        {
          clientMessageId: 'message_1234567890',
          content: '多少钱？',
          createdAt: '2026-09-21T08:00:00.000Z',
          messageId: 'server_message_1',
          role: 'visitor',
          sequence: 1,
        },
      ],
      releaseRef: snapshot.releaseRef,
      sessionHandle,
      snapshot: snapshotData,
    };
    expect(decodePublicSessionHistory(envelope(history))).toMatchObject({
      activeTurn: history.activeTurn,
      messages: history.messages,
      snapshot: snapshotData,
    });
    expect(
      decodePublicSessionHistory(
        envelope({ ...history, activeTurn: { ...history.activeTurn, content: '篡改后的问题' } }),
      ),
    ).toBeUndefined();
    expect(
      decodePublicSessionHistory(
        envelope({
          ...history,
          snapshot: { ...snapshotData, releaseRef: 'release_other_1234567890' },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('authenticated execution response headers preserve original public protocol', () => {
  const clientMessageId = 'message_original_123456';
  const turnId = 'turn_original_123456';
  const visitor = {
    clientMessageId,
    content: '原始问题',
    createdAt: '2026-11-17T00:00:00Z',
    messageId: 'message_public_1234',
    role: 'visitor',
    sequence: 1,
  };
  const result = {
    sessionHandle,
    turnId,
    traceId: 'trace_original_123456',
    state: 'accepted',
    messages: [visitor],
  };
  const resultUrl = `${origin}/api/v1/public/sessions/${sessionHandle}/turns/${turnId}`;
  it.each(['runnable', 'paused', 'draining', 'not-applicable', 'unavailable'] as const)(
    'accepts only enum value %s',
    (value) => {
      expect(
        publicExecutionState(new Response('', { headers: { 'X-H5CS-Execution-State': value } })),
      ).toBe(value);
    },
  );
  it('ignores arbitrary or missing header text, without adding fields to strict JSON', () => {
    expect(
      publicExecutionState(
        new Response('', { headers: { 'X-H5CS-Execution-State': 'operator private reason' } }),
      ),
    ).toBeNull();
    expect(publicExecutionState(new Response())).toBeNull();
    expect(decodeTurnResult(envelope({ ...result, executionState: 'paused' }))).toBeUndefined();
  });
  it('polls exactly the original result URL and updates state from each authenticated response, never caches a pause', async () => {
    const onExecutionState = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(envelope(result)), {
          headers: { 'Content-Type': 'application/json', 'X-H5CS-Execution-State': 'paused' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(envelope(result)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(envelope({ ...result, state: 'completed' })), {
          headers: { 'Content-Type': 'application/json', 'X-H5CS-Execution-State': 'paused' },
        }),
      );
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      origin,
      fetchImpl,
      onExecutionState,
    });
    const input = { clientMessageId, resultUrl, sessionHandle, turnId };
    expect((await client.readTurn(input)).state).toBe('accepted');
    expect((await client.readTurn(input)).state).toBe('accepted');
    expect((await client.readTurn(input)).state).toBe('completed');
    expect(onExecutionState.mock.calls.map((call) => call[0])).toEqual(['paused', null, null]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) {
      expect(call[0]).toBe(resultUrl);
      expect(call[1].method).toBe('GET');
    }
  });
  it('reads only the initial SSE header and leaves all event frames unchanged, with terminal result taking priority', async () => {
    const onExecutionState = vi.fn();
    const completed = { ...result, state: 'completed' };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        `event: accepted\ndata: ${JSON.stringify(result)}\n\nevent: completed\ndata: ${JSON.stringify(completed)}\n\n`,
        {
          headers: { 'Content-Type': 'text/event-stream', 'X-H5CS-Execution-State': 'draining' },
        },
      ),
    );
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      origin,
      fetchImpl,
      onExecutionState,
    });
    const states: string[] = [];
    for await (const event of client.streamTurn({
      clientMessageId,
      eventsUrl: `${resultUrl}/events`,
      sessionHandle,
      turnId,
    }))
      states.push(event.state);
    expect(states).toEqual(['accepted', 'completed']);
    expect(onExecutionState.mock.calls.map((call) => call[0])).toEqual(['draining', null]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('paused send keeps the original request IDs and never forwards operator diagnostics', async () => {
    const onExecutionState = vi.fn();
    const response = jsonResponse(
      {
        request_id: 'request_paused_12345',
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'internal operator reason',
          retryable: true,
        },
      },
      503,
    );
    response.headers.set('X-H5CS-Execution-State', 'paused');
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      origin,
      fetchImpl,
      onExecutionState,
    });
    await expect(
      client.sendMessage({ clientMessageId, content: '原始问题', sessionHandle }),
    ).rejects.not.toThrow('operator');
    expect(onExecutionState).toHaveBeenCalledExactlyOnceWith('paused');
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({
      clientMessageId,
      content: '原始问题',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([null, 'unrecognized'])(
    'initial live SSE header %s does not erase the trusted draining send state',
    async (header) => {
      const onExecutionState = vi.fn();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`event: accepted\ndata: ${JSON.stringify(result)}\n\n`),
          );
        },
        cancel,
      });
      const headers = new Headers({ 'Content-Type': 'text/event-stream' });
      if (header !== null) headers.set('X-H5CS-Execution-State', header);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(
              envelope({
                state: 'accepted',
                turnId,
                traceId: result.traceId,
                eventsUrl: `${resultUrl}/events`,
                resultUrl,
              }),
            ),
            {
              status: 202,
              headers: { 'Content-Type': 'application/json', 'X-H5CS-Execution-State': 'draining' },
            },
          ),
        )
        .mockResolvedValueOnce(new Response(body, { headers }));
      const client = createPublicAssistantApiClient({
        apiBaseUrl: '/api/v1/public',
        origin,
        fetchImpl,
        onExecutionState,
      });
      await client.sendMessage({ clientMessageId, content: visitor.content, sessionHandle });
      const controller = new AbortController();
      const iterator = client.streamTurn({
        clientMessageId,
        eventsUrl: `${resultUrl}/events`,
        sessionHandle,
        turnId,
        signal: controller.signal,
      });
      expect((await iterator.next()).value?.state).toBe('accepted');
      expect(onExecutionState.mock.calls.map((call) => call[0])).toEqual(['draining']);
      controller.abort();
      await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
      expect(cancel).toHaveBeenCalledOnce();
      expect(onExecutionState.mock.calls.map((call) => call[0])).toEqual(['draining']);
    },
  );
});

describe('public assistant API client', () => {
  it('reads same-origin SSE states with cookies and a validated terminal result', async () => {
    const turnId = 'turn_1234567890';
    const clientMessageId = 'message_client_1234567890';
    const accepted = {
      messages: [
        {
          clientMessageId,
          content: '多少钱？',
          createdAt: '2026-09-21T08:00:00.000Z',
          messageId: 'server_message_1',
          role: 'visitor',
          sequence: 1,
        },
      ],
      sessionHandle,
      state: 'accepted',
      traceId: 'trace_1234567890',
      turnId,
    };
    const completed = {
      ...accepted,
      messages: [
        ...accepted.messages,
        {
          content: '请以商家最终报价为准。',
          createdAt: '2026-09-21T08:00:01.000Z',
          messageId: 'server_message_2',
          role: 'assistant',
          sequence: 2,
        },
      ],
      state: 'completed',
    };
    const stream = `event: accepted\ndata: ${JSON.stringify(accepted)}\n\n: keepalive\n\nevent: completed\ndata: ${JSON.stringify(completed)}\n\n`;
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    );
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl,
      origin,
    });
    const received = [];
    for await (const result of client.streamTurn({
      clientMessageId,
      eventsUrl: `${origin}/api/v1/public/sessions/${sessionHandle}/turns/${turnId}/events`,
      sessionHandle,
      turnId,
    })) {
      received.push(result.state);
    }
    expect(received).toEqual(['accepted', 'completed']);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${origin}/api/v1/public/sessions/${sessionHandle}/turns/${turnId}/events`,
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'text/event-stream' },
        method: 'GET',
      }),
    );
  });

  it('uses same-origin credentialed GETs for resume and history', async () => {
    const session = {
      createdAt: '2026-09-21T08:00:00.000Z',
      releaseRef: snapshot.releaseRef,
      sessionHandle,
      state: 'active',
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(envelope(session)))
      .mockResolvedValueOnce(
        jsonResponse(
          envelope({
            activeTurn: null,
            createdAt: session.createdAt,
            hasEarlierMessages: false,
            messages: [],
            releaseRef: session.releaseRef,
            sessionHandle: session.sessionHandle,
            snapshot: snapshotData,
          }),
        ),
      );
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl,
      origin,
    });
    await expect(
      client.resumeSession({ publicSlug: 'shop-help', sessionRequestId }),
    ).resolves.toEqual(session);
    await expect(
      client.loadHistory({ sessionHandle: session.sessionHandle }),
    ).resolves.toMatchObject({ session, snapshot: snapshotData });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `${origin}/api/v1/public/assistants/shop-help/sessions/${sessionRequestId}`,
      `${origin}/api/v1/public/sessions/${session.sessionHandle}/history`,
    ]);
    expect(fetchImpl.mock.calls.map(([, options]) => options)).toEqual([
      expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }),
      expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }),
    ]);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      'X-H5CS-Features': 'human-contact',
    });
  });

  it('negotiates human contact on snapshot reads while accepting an older API without the field', async () => {
    const legacySnapshot = { ...snapshotData };
    Reflect.deleteProperty(legacySnapshot, 'humanContact');
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(envelope(legacySnapshot)));
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl,
      origin,
    });
    await expect(client.loadAssistant('shop-help')).resolves.toMatchObject({
      status: 'online',
      snapshot: { humanContact: '' },
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-H5CS-Features': 'human-contact',
    });
  });

  it('ends only the selected session with its visitor cookie and validates the confirmation', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(envelope({ sessionHandle, state: 'ended' })))
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(
        jsonResponse(envelope({ sessionHandle: otherSessionHandle, state: 'ended' })),
      )
      .mockResolvedValueOnce(jsonResponse({}, 503));
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl,
      origin,
    });

    await expect(client.endSession({ sessionHandle })).resolves.toBe(true);
    await expect(client.endSession({ sessionHandle })).resolves.toBe(false);
    await expect(client.endSession({ sessionHandle })).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    await expect(client.endSession({ sessionHandle })).rejects.toMatchObject({
      kind: 'request_failed',
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      `${origin}/api/v1/public/sessions/${sessionHandle}/end`,
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
      method: 'POST',
    });
  });

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
            sessionHandle,
            state: 'active',
          }),
          201,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          envelope({
            eventsUrl: `/api/v1/public/sessions/${sessionHandle}/turns/turn_1234567890/events`,
            resultUrl: `/api/v1/public/sessions/${sessionHandle}/turns/turn_1234567890`,
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
      sessionRequestId,
      snapshot,
    });
    const [, sessionRequest] = fetchImpl.mock.calls[0]!;
    expect(sessionRequest?.body).toBeUndefined();
    expect(sessionRequest?.headers).toMatchObject({
      'Idempotency-Key': sessionRequestId,
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
        resultUrl: `/api/v1/public/sessions/${otherSessionHandle}/turns/turn_1234567890`,
        sessionHandle,
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
        sessionRequestId,
        snapshot,
      }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      requestId: 'request_1234567890',
      retryable: true,
    });
  });

  it('preserves the safe withdrawal code without exposing the upstream diagnostic text', async () => {
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'RELEASE_WITHDRAWN',
              message: 'private diagnostic must stay hidden',
              retryable: false,
            },
            request_id: 'request_1234567890',
          },
          409,
        ),
      ),
      origin,
    });
    await expect(client.loadHistory({ sessionHandle })).rejects.toMatchObject({
      code: 'RELEASE_WITHDRAWN',
      retryable: false,
      requestId: 'request_1234567890',
    });
    await expect(client.loadHistory({ sessionHandle })).rejects.not.toThrow('private diagnostic');
  });

  it('retains only the validated support reference for an unavailable entry', async () => {
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: 'internal information',
              retryable: true,
            },
            request_id: 'request_1234567890',
          },
          503,
        ),
      ),
      origin,
    });
    await expect(client.loadAssistant('shop-help')).resolves.toEqual({
      reason: 'api_unavailable',
      status: 'unavailable',
      requestId: 'request_1234567890',
    });
  });
});
