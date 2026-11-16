import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPublicAssistantApiClient,
  type AcceptedTurn,
  type TurnResult,
} from './public-api-client';
import { observePublicTurn } from './turn-observation';

const origin = 'https://h5.example.test';
const sessionHandle = `s_${'a'.repeat(32)}`;
const clientMessageId = 'message_original_12345';
const turnId = 'turn_original_12345';
const resultUrl = `${origin}/api/v1/public/sessions/${sessionHandle}/turns/${turnId}`;
const accepted: AcceptedTurn = {
  resultUrl,
  eventsUrl: `${resultUrl}/events`,
  turnId,
  traceId: 'trace_original_12345',
  state: 'accepted',
};
const visitor = {
  clientMessageId,
  content: '原咨询问题',
  createdAt: '2026-11-17T00:00:00Z',
  messageId: 'message_original_visitor',
  role: 'visitor' as const,
  sequence: 1,
};
const processing: TurnResult = {
  sessionHandle,
  turnId,
  traceId: accepted.traceId,
  state: 'processing',
  messages: [visitor],
};
const completed: TurnResult = { ...processing, state: 'completed' };
const json = (result: TurnResult, state: string) =>
  Response.json(
    { data: result, request_id: 'request_original_12345' },
    { headers: { 'X-H5CS-Execution-State': state } },
  );
const frame = (result: TurnResult) =>
  new TextEncoder().encode(`event: ${result.state}\ndata: ${JSON.stringify(result)}\n\n`);
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('bounded live SSE to durable result observation (real client + ReadableStream, mock HTTP)', () => {
  it('switches despite endless keepalives, then observes pause/drain/resume through the exact original GET and stops on terminal', async () => {
    const cancel = vi.fn();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(frame(processing));
      },
      cancel,
    });
    const reads = [
      json(processing, 'paused'),
      json(processing, 'draining'),
      json(processing, 'runnable'),
      json(completed, 'paused'),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/events')
        ? new Response(body, {
            headers: { 'Content-Type': 'text/event-stream', 'X-H5CS-Execution-State': 'runnable' },
          })
        : reads.shift()!,
    );
    const onExecutionState = vi.fn();
    const onResult = vi.fn();
    const controller = new AbortController();
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      origin,
      fetchImpl,
      onExecutionState,
    });
    const task = observePublicTurn({
      client,
      accepted,
      clientMessageId,
      sessionHandle,
      signal: controller.signal,
      onResult,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(400);
    source.enqueue(new TextEncoder().encode(': still-open\n\n'));
    await vi.advanceTimersByTimeAsync(400);
    source.enqueue(frame(processing));
    await vi.advanceTimersByTimeAsync(700);
    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(false);
    expect(onExecutionState.mock.calls.map((call) => call[0])).toEqual(['runnable', 'paused']);
    await vi.advanceTimersByTimeAsync(3000);
    await task;
    expect(onExecutionState.mock.calls.map((call) => call[0])).toEqual([
      'runnable',
      'paused',
      'draining',
      'runnable',
      null,
    ]);
    expect(onResult.mock.calls.at(-1)?.[0]).toEqual(completed);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    for (const [url, options] of fetchImpl.mock.calls.slice(1)) {
      expect(String(url)).toBe(resultUrl);
      expect(options).toMatchObject({
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      expect(options?.body).toBeUndefined();
    }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(90000);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it.each(['completed', 'failed'] as const)(
    'terminal SSE %s wins before the grace deadline and releases the live reader without GET',
    async (state) => {
      const terminal: TurnResult =
        state === 'completed'
          ? completed
          : { ...processing, state, error: { code: 'SERVICE_UNAVAILABLE', retryable: true } };
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame(terminal));
        },
        cancel,
      });
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: { 'Content-Type': 'text/event-stream', 'X-H5CS-Execution-State': 'paused' },
        }),
      );
      const onExecutionState = vi.fn(),
        onResult = vi.fn();
      const client = createPublicAssistantApiClient({
        apiBaseUrl: '/api/v1/public',
        origin,
        fetchImpl,
        onExecutionState,
      });
      await observePublicTurn({
        client,
        accepted,
        clientMessageId,
        sessionHandle,
        signal: new AbortController().signal,
        onResult,
      });
      expect(onResult).toHaveBeenCalledExactlyOnceWith(terminal);
      expect(onExecutionState.mock.calls.map((call) => call[0])).toEqual(['paused', null]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('leaving while SSE never completes cancels the reader and grace timer without issuing GET', async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      origin,
      fetchImpl,
    });
    const controller = new AbortController();
    const onResult = vi.fn();
    const outcome = observePublicTurn({
      client,
      accepted,
      clientMessageId,
      sessionHandle,
      signal: controller.signal,
      onResult,
    }).catch((error) => error);
    await flush();
    controller.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(onResult).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(90000);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('ignores a noncooperative late old stream terminal after GET has already completed the consultation', async () => {
    let release!: () => void;
    let streamSignal!: AbortSignal;
    const readTurn = vi.fn().mockResolvedValue(completed);
    const client = {
      readTurn,
      async *streamTurn(input: { signal?: AbortSignal | undefined }) {
        streamSignal = input.signal!;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield {
          ...processing,
          state: 'failed' as const,
          error: { code: 'SERVICE_UNAVAILABLE', retryable: true },
        };
      },
    };
    const onResult = vi.fn();
    const task = observePublicTurn({
      client,
      accepted,
      clientMessageId,
      sessionHandle,
      signal: new AbortController().signal,
      onResult,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await task;
    expect(streamSignal.aborted).toBe(true);
    release();
    await flush();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(completed);
    expect(readTurn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['next-reject', 'return-reject'] as const)(
    'consumes late iterator %s after switching to a completed GET',
    async (failure) => {
      let release!: () => void;
      const readTurn = vi.fn().mockResolvedValue(completed);
      const client = {
        readTurn,
        async *streamTurn() {
          try {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            if (failure === 'next-reject') throw Error('late next rejection');
            yield processing;
          } finally {
            if (failure === 'return-reject') throw Error('late return rejection');
          }
        },
      };
      const onResult = vi.fn();
      const task = observePublicTurn({
        client,
        accepted,
        clientMessageId,
        sessionHandle,
        signal: new AbortController().signal,
        onResult,
      });
      await vi.advanceTimersByTimeAsync(1500);
      await task;
      release();
      await flush();
      expect(onResult).toHaveBeenCalledExactlyOnceWith(completed);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('terminal result does not wait for a permanently hanging iterator cleanup or start a later GET', async () => {
    const readTurn = vi.fn();
    const client = {
      readTurn,
      async *streamTurn() {
        try {
          yield completed;
        } finally {
          await new Promise<void>(() => {});
        }
      },
    };
    const onResult = vi.fn();
    await observePublicTurn({
      client,
      accepted,
      clientMessageId,
      sessionHandle,
      signal: new AbortController().signal,
      onResult,
    });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(completed);
    await vi.advanceTimersByTimeAsync(90000);
    expect(readTurn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a denied original GET is not a terminal result or a reason to POST again', async () => {
    const body = new ReadableStream();
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/events')
        ? new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
        : Response.json(
            {
              error: { code: 'NOT_FOUND', message: 'not authorized', retryable: false },
              request_id: 'request_denied_12345',
            },
            { status: 404, headers: { 'X-H5CS-Execution-State': 'paused' } },
          ),
    );
    const onExecutionState = vi.fn(),
      onResult = vi.fn();
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      origin,
      fetchImpl,
      onExecutionState,
    });
    const outcome = observePublicTurn({
      client,
      accepted,
      clientMessageId,
      sessionHandle,
      signal: new AbortController().signal,
      onResult,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await outcome).toMatchObject({ kind: 'request_failed', code: 'NOT_FOUND' });
    expect(onResult).not.toHaveBeenCalled();
    expect(onExecutionState).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a hanging GET and ignores its late state or result after timeout', async () => {
    let resolveRead!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/events')
        ? new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } })
        : new Promise<Response>((resolve) => {
            resolveRead = resolve;
          }),
    );
    const onExecutionState = vi.fn(),
      onResult = vi.fn();
    const client = createPublicAssistantApiClient({
      apiBaseUrl: '/api/v1/public',
      origin,
      fetchImpl,
      onExecutionState,
    });
    const outcome = observePublicTurn({
      client,
      accepted,
      clientMessageId,
      sessionHandle,
      signal: new AbortController().signal,
      onResult,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(12000);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    resolveRead(json(completed, 'paused'));
    await flush();
    expect(onResult).not.toHaveBeenCalled();
    expect(onExecutionState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
