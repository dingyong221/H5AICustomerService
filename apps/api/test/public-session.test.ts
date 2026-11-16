import { HttpStatus, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { EXECUTION_STATE_HEADER, type ExecutionState } from '@h5cs/contracts';

import {
  PublicReleaseWithdrawnError,
  PublicTurnConflictError,
  RuntimeExecutionBlockedError,
} from '@h5cs/database';

import { AppModule } from '../src/app.module.js';
import type { EventStreamResponseLike } from '../src/http-types.js';
import { PublicSessionService } from '../src/public/public-session.service.js';
import { PublicTurnController } from '../src/public/public-turn.controller.js';
import { PublicTurnService } from '../src/public/public-turn.service.js';

const sessionRequestId = `session_request_${'11'.repeat(16)}`;
const publicSlug = 'a-example-assistant';
const session = {
  sessionHandle: `s_${'22'.repeat(16)}`,
  releaseRef: '33'.repeat(16),
  state: 'active' as const,
  createdAt: '2026-09-24T00:00:00.000Z',
};

describe('public visitor session issuance', () => {
  it('returns the non-retryable withdrawal code only for a repository-verified visitor session', async () => {
    const withdrawn = vi.fn(async () => {
      throw new PublicReleaseWithdrawnError();
    });
    const service = new PublicSessionService(
      {
        createSession: withdrawn,
        resumeSession: withdrawn,
        readHistory: withdrawn,
        endSession: withdrawn,
      },
      false,
    );
    const expected = {
      status: HttpStatus.CONFLICT,
      response: { code: 'RELEASE_WITHDRAWN', retryable: false },
    };
    const cookieHeader = `h5cs_visitor=${'A'.repeat(43)}`;
    await expect(
      service.create({ publicSlug, idempotencyKey: sessionRequestId, cookieHeader }),
    ).rejects.toMatchObject(expected);
    await expect(
      service.resume({ publicSlug, sessionRequestId, cookieHeader }),
    ).rejects.toMatchObject(expected);
    await expect(service.history(session.sessionHandle, cookieHeader)).rejects.toMatchObject(
      expected,
    );
    await expect(service.end(session.sessionHandle, cookieHeader)).rejects.toMatchObject(expected);
    await expect(service.history(session.sessionHandle, undefined)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(withdrawn).toHaveBeenCalledTimes(4);
  });
  it('sets an HttpOnly secure nonce cookie and reuses it on idempotent retries', async () => {
    const createSession = vi.fn(async (_input: { visitorNonce: string }) => session);
    const service = new PublicSessionService({ createSession }, true);
    const first = await service.create({
      publicSlug,
      idempotencyKey: sessionRequestId,
      cookieHeader: undefined,
    });
    expect(first.session).toEqual(session);
    expect(first.setCookie).toMatch(/^__Host-h5cs_visitor=[A-Za-z0-9_-]{43}; Path=\/;/u);
    expect(first.setCookie).toContain('HttpOnly; SameSite=Lax; Secure');
    const cookieHeader = first.setCookie!.split(';')[0]!;
    const second = await service.create({
      publicSlug,
      idempotencyKey: sessionRequestId,
      cookieHeader,
    });
    expect(second.setCookie).toBeNull();
    expect(createSession.mock.calls[0]?.[0].visitorNonce).toBe(
      createSession.mock.calls[1]?.[0].visitorNonce,
    );
  });

  it('rejects malformed keys and fails closed while conversations are disabled', async () => {
    const service = new PublicSessionService(null, false);
    await expect(
      service.create({ publicSlug, idempotencyKey: 'weak', cookieHeader: undefined }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    await expect(
      service.create({ publicSlug, idempotencyKey: sessionRequestId, cookieHeader: undefined }),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
    await expect(
      PublicSessionService.fromEnvironment({
        NODE_ENV: 'production',
        PUBLIC_CONVERSATION_ENABLED: 'true',
        CONSUMER_H5_ORIGIN: 'http://127.0.0.1:3001',
      }).create({ publicSlug, idempotencyKey: sessionRequestId, cookieHeader: undefined }),
    ).rejects.toMatchObject({ status: HttpStatus.SERVICE_UNAVAILABLE });
  });

  it('does not trust duplicate visitor cookies', async () => {
    const createSession = vi.fn(async (_input: { visitorNonce: string }) => session);
    const service = new PublicSessionService({ createSession }, false);
    const result = await service.create({
      publicSlug,
      idempotencyKey: sessionRequestId,
      cookieHeader: `h5cs_visitor=${'A'.repeat(43)}; h5cs_visitor=${'B'.repeat(43)}`,
    });
    expect(result.setCookie).toMatch(/^h5cs_visitor=[A-Za-z0-9_-]{43};/u);
  });

  it('requires the bound visitor cookie to resume and read history', async () => {
    const nonce = 'A'.repeat(43);
    const history = {
      sessionHandle: session.sessionHandle,
      releaseRef: session.releaseRef,
      createdAt: session.createdAt,
      snapshot: {
        publicAssistantId: publicSlug,
        merchantDisplayName: '示例商家',
        assistantDisplayName: '售前助手',
        aiDisclosure: true as const,
        businessScope: '空调清洗',
        welcomeMessage: '你好',
        humanContact: '',
        availability: 'online' as const,
        releaseRef: session.releaseRef,
      },
      messages: [],
      activeTurn: null,
      hasEarlierMessages: false,
    };
    const resumeSession = vi.fn(async (_input: { visitorNonce: string }) => session);
    const readHistory = vi.fn(async (_handle: string) => history);
    const service = new PublicSessionService(
      {
        createSession: vi.fn(async () => session),
        resumeSession,
        readHistory,
      },
      true,
    );
    await expect(
      service.resume({ publicSlug, sessionRequestId, cookieHeader: undefined }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    expect(resumeSession).not.toHaveBeenCalled();
    await expect(
      service.resume({
        publicSlug,
        sessionRequestId,
        cookieHeader: `__Host-h5cs_visitor=${nonce}`,
      }),
    ).resolves.toEqual(session);
    expect(resumeSession.mock.calls[0]?.[0].visitorNonce).toBe(nonce);
    await expect(service.history(session.sessionHandle, undefined)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(readHistory).not.toHaveBeenCalled();
    await expect(
      service.history(session.sessionHandle, `__Host-h5cs_visitor=${nonce}`),
    ).resolves.toEqual(history);
    expect(readHistory).toHaveBeenCalledWith(session.sessionHandle, nonce, expect.any(Date));
  });

  it('requires the visitor cookie to end a session and preserves an in-flight conflict', async () => {
    const nonce = 'A'.repeat(43);
    const endSession = vi.fn(async () => ({
      sessionHandle: session.sessionHandle,
      state: 'ended' as const,
    }));
    const service = new PublicSessionService(
      { createSession: vi.fn(async () => session), endSession },
      true,
    );
    await expect(service.end(session.sessionHandle, undefined)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(endSession).not.toHaveBeenCalled();
    await expect(
      service.end(session.sessionHandle, `__Host-h5cs_visitor=${nonce}`),
    ).resolves.toEqual({ sessionHandle: session.sessionHandle, state: 'ended' });
    expect(endSession).toHaveBeenCalledWith({
      sessionHandle: session.sessionHandle,
      visitorNonce: nonce,
      now: expect.any(Date),
    });
    endSession.mockRejectedValueOnce(new PublicTurnConflictError('TURN_IN_PROGRESS'));
    await expect(
      service.end(session.sessionHandle, `__Host-h5cs_visitor=${nonce}`),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('keeps the actual public session route unavailable before the full conversation runtime is ready', async () => {
    const previous = process.env['PUBLIC_CONVERSATION_ENABLED'];
    process.env['PUBLIC_CONVERSATION_ENABLED'] = 'false';
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const response = await fetch(
        `${await app.getUrl()}/api/v1/public/assistants/${publicSlug}/sessions`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': sessionRequestId },
        },
      );
      const resumed = await fetch(
        `${await app.getUrl()}/api/v1/public/assistants/${publicSlug}/sessions/${sessionRequestId}`,
      );
      const history = await fetch(
        `${await app.getUrl()}/api/v1/public/sessions/${session.sessionHandle}/history`,
      );
      const ended = await fetch(
        `${await app.getUrl()}/api/v1/public/sessions/${session.sessionHandle}/end`,
        { method: 'POST' },
      );
      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(resumed.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(history.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(ended.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(resumed.headers.get('cache-control')).toBe('no-store');
      expect(history.headers.get('cache-control')).toBe('no-store');
      expect(ended.headers.get('cache-control')).toBe('no-store');
    } finally {
      await app.close();
      if (previous === undefined) delete process.env['PUBLIC_CONVERSATION_ENABLED'];
      else process.env['PUBLIC_CONVERSATION_ENABLED'] = previous;
    }
  });
});

describe('public conversation turn contract', () => {
  const handle = `s_${'22'.repeat(16)}`;
  const nonce = 'A'.repeat(43);
  const messageId = `message_${'55'.repeat(16)}`;
  const turnId = `t_${'88'.repeat(16)}`;

  it('attaches only an execution enum after authorized reads while keeping the exact turn JSON', async () => {
    const result = {
      sessionHandle: handle,
      turnId,
      traceId: 'trace_' + '88'.repeat(16),
      state: 'processing' as const,
      messages: [],
    };
    const state = vi.fn(async () => 'paused' as const),
      readTurn = vi.fn(async () => result);
    const turns = new PublicTurnService(
      { acceptTurn: vi.fn(), readTurn, readTurnExecutionState: state },
      'https://h5cs.1rying.com',
    );
    const controller = new PublicTurnController(turns, new PublicSessionService(null, true));
    const headers = new Map<string, string>(),
      response = {
        setHeader: (k: string, v: string) => headers.set(k, v),
        status() {
          return this;
        },
        json() {
          return undefined;
        },
      };
    expect(await controller.read(handle, turnId, `__Host-h5cs_visitor=${nonce}`, response)).toEqual(
      result,
    );
    expect(headers.get('X-H5CS-Execution-State')).toBe('paused');
    expect(state).toHaveBeenCalledOnce();
    headers.clear();
    await expect(controller.read(handle, turnId, undefined, response)).rejects.toMatchObject({
      status: 404,
    });
    expect(headers.has('X-H5CS-Execution-State')).toBe(false);
    expect(state).toHaveBeenCalledOnce();
  });
  it('keeps the existing unavailable status for paused new requests without exposing operator reasons', async () => {
    const turns = new PublicTurnService(
      {
        acceptTurn: async () => {
          throw new RuntimeExecutionBlockedError();
        },
        readTurn: vi.fn(),
      },
      'https://h5cs.1rying.com',
    );
    const controller = new PublicTurnController(turns, new PublicSessionService(null, true));
    const headers = new Map<string, string>(),
      response = {
        setHeader: (k: string, v: string) => headers.set(k, v),
        status() {
          return this;
        },
        json() {
          return undefined;
        },
      };
    await expect(
      controller.send(
        handle,
        messageId,
        `__Host-h5cs_visitor=${nonce}`,
        { clientMessageId: messageId, content: '合成问题' },
        response,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(headers.get('X-H5CS-Execution-State')).toBe('paused');
    expect([...headers.values()].join(' ')).not.toContain('reason');
  });

  it('maps withdrawn turn reads and sends to a non-retryable conflict', async () => {
    const withdrawn = vi.fn(async () => {
      throw new PublicReleaseWithdrawnError();
    });
    const service = new PublicTurnService(
      { acceptTurn: withdrawn, readTurn: withdrawn },
      'https://h5cs.1rying.com',
    );
    const expected = {
      status: HttpStatus.CONFLICT,
      response: { code: 'RELEASE_WITHDRAWN', retryable: false },
    };
    await expect(
      service.send({
        sessionHandle: handle,
        visitorNonce: nonce,
        idempotencyKey: messageId,
        body: { clientMessageId: messageId, content: '合成问题' },
      }),
    ).rejects.toMatchObject(expected);
    await expect(service.read(handle, nonce, turnId)).rejects.toMatchObject(expected);
  });

  it('returns same-origin poll URLs only after a durable turn has been accepted', async () => {
    const acceptTurn = vi.fn(async () => ({ turnId, traceId: `trace_${'88'.repeat(16)}` }));
    const readTurn = vi.fn(async () => null);
    const service = new PublicTurnService({ acceptTurn, readTurn }, 'https://h5cs.1rying.com');
    const accepted = await service.send({
      sessionHandle: handle,
      visitorNonce: nonce,
      idempotencyKey: messageId,
      body: { clientMessageId: messageId, content: '多少钱？' },
    });
    expect(accepted).toEqual({
      turnId,
      traceId: `trace_${'88'.repeat(16)}`,
      state: 'accepted',
      eventsUrl: `https://h5cs.1rying.com/api/v1/public/sessions/${handle}/turns/${turnId}/events`,
      resultUrl: `https://h5cs.1rying.com/api/v1/public/sessions/${handle}/turns/${turnId}`,
    });
    expect(accepted.eventsUrl).not.toContain(nonce);
    expect(accepted.resultUrl).not.toContain(nonce);
    expect(acceptTurn).toHaveBeenCalledOnce();
    expect(acceptTurn).toHaveBeenCalledWith(expect.objectContaining({ visitorNonce: nonce }));
    await expect(
      service.send({
        sessionHandle: handle,
        visitorNonce: null,
        idempotencyKey: messageId,
        body: { clientMessageId: messageId, content: '多少钱？' },
      }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    expect(acceptTurn).toHaveBeenCalledOnce();
    await expect(
      service.send({
        sessionHandle: handle,
        visitorNonce: nonce,
        idempotencyKey: messageId,
        body: { clientMessageId: messageId, content: '多少钱？', role: 'admin' },
      }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(acceptTurn).toHaveBeenCalledOnce();
  });

  it('keeps message and poll routes closed until the runtime is enabled', async () => {
    const previous = process.env['PUBLIC_CONVERSATION_ENABLED'];
    process.env['PUBLIC_CONVERSATION_ENABLED'] = 'false';
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const sent = await fetch(`${base}/api/v1/public/sessions/${handle}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': messageId },
        body: JSON.stringify({ clientMessageId: messageId, content: '多少钱？' }),
      });
      const read = await fetch(`${base}/api/v1/public/sessions/${handle}/turns/${turnId}`);
      const events = await fetch(
        `${base}/api/v1/public/sessions/${handle}/turns/${turnId}/events`,
        {
          headers: { Accept: 'text/event-stream' },
        },
      );
      expect(sent.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(read.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(events.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(sent.headers.get('cache-control')).toBe('no-store');
      expect(read.headers.get('cache-control')).toBe('no-store');
      expect(events.headers.get('cache-control')).toBe('no-store');
    } finally {
      await app.close();
      if (previous === undefined) delete process.env['PUBLIC_CONVERSATION_ENABLED'];
      else process.env['PUBLIC_CONVERSATION_ENABLED'] = previous;
    }
  });

  it('streams authorized turn state changes and closes at the terminal result', async () => {
    const accepted = {
      sessionHandle: handle,
      turnId,
      traceId: `trace_${'88'.repeat(16)}`,
      state: 'accepted' as const,
      messages: [],
    };
    const processing = { ...accepted, state: 'processing' as const };
    const completed = { ...accepted, state: 'completed' as const };
    const results = [accepted, processing, completed];
    const readTurn = vi.fn(async () => results.shift() ?? completed);
    const turns = new PublicTurnService(
      { acceptTurn: vi.fn(), readTurn },
      'https://h5cs.1rying.com',
      1,
    );
    const controller = new PublicTurnController(turns, new PublicSessionService(null, true));
    const headers = new Map<string, string>();
    const written: string[] = [];
    let ended = false;
    const response: EventStreamResponseLike = {
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value);
      },
      status() {
        return this;
      },
      json() {
        return undefined;
      },
      on() {},
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
      end() {
        ended = true;
      },
    };
    const nonce = 'A'.repeat(43);
    await controller.events(handle, turnId, `__Host-h5cs_visitor=${nonce}`, response);
    expect(readTurn).toHaveBeenCalledTimes(3);
    expect(readTurn).toHaveBeenCalledWith(handle, nonce, turnId, expect.any(Date));
    expect(written.map((chunk) => chunk.split('\n')[0])).toEqual([
      'event: accepted',
      'event: processing',
      'event: completed',
    ]);
    expect(written.join('')).not.toContain(nonce);
    expect(headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(headers.get('x-accel-buffering')).toBe('no');
    expect(ended).toBe(true);
    await expect(controller.events(handle, turnId, undefined, response)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(readTurn).toHaveBeenCalledTimes(3);
  });

  it('serves SSE over the actual HTTP route without turning events into JSON envelopes', async () => {
    const visitorMessage = {
      messageId: '77'.repeat(16),
      sequence: 1,
      role: 'visitor' as const,
      content: '多少钱？',
      createdAt: '2026-09-24T00:00:00.000Z',
      clientMessageId: messageId,
    };
    const accepted = {
      sessionHandle: handle,
      turnId,
      traceId: `trace_${'88'.repeat(16)}`,
      state: 'accepted' as const,
      messages: [visitorMessage],
    };
    const completed = { ...accepted, state: 'completed' as const };
    const results = [accepted, completed];
    const turns = new PublicTurnService(
      { acceptTurn: vi.fn(), readTurn: vi.fn(async () => results.shift() ?? completed) },
      'https://h5cs.1rying.com',
      1,
    );
    @Module({
      controllers: [PublicTurnController],
      providers: [
        { provide: PublicTurnService, useValue: turns },
        { provide: PublicSessionService, useValue: new PublicSessionService(null, true) },
      ],
    })
    class EventTestModule {}
    const app = await NestFactory.create(EventTestModule, { logger: false });
    try {
      await app.listen(0, '127.0.0.1');
      const url = `${await app.getUrl()}/api/v1/public/sessions/${handle}/turns/${turnId}/events`;
      const unauthorized = await fetch(url, { headers: { Accept: 'text/event-stream' } });
      expect(unauthorized.status).toBe(HttpStatus.NOT_FOUND);
      const response = await fetch(url, {
        headers: { Accept: 'text/event-stream', Cookie: `__Host-h5cs_visitor=${'A'.repeat(43)}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text();
      expect(body).toContain('event: accepted\n');
      expect(body).toContain('event: completed\n');
      expect(body).not.toContain('"request_id"');
    } finally {
      await app.close();
    }
  });

  const streamFixture = async (
    executionState: ExecutionState | Error,
    initialState: 'accepted' | 'completed' | 'failed' = 'accepted',
  ) => {
    const first = {
      sessionHandle: handle,
      turnId,
      traceId: `trace_${'88'.repeat(16)}`,
      state: initialState,
      messages: [],
    };
    const completed = { ...first, state: 'completed' as const };
    let authorizedReads = 0;
    const order: string[] = [];
    const readTurn = vi.fn(
      async (sessionHandle: string, visitor: string, requestedTurn: string) => {
        order.push('read');
        if (sessionHandle !== handle || visitor !== nonce || requestedTurn !== turnId) return null;
        authorizedReads++;
        return authorizedReads === 1 ? first : completed;
      },
    );
    const readTurnExecutionState = vi.fn(
      async (sessionHandle: string, visitor: string, requestedTurn: string) => {
        order.push('execution');
        expect(authorizedReads).toBe(1);
        expect([sessionHandle, visitor, requestedTurn]).toEqual([handle, nonce, turnId]);
        if (executionState instanceof Error) throw executionState;
        return executionState;
      },
    );
    const turns = new PublicTurnService(
      { acceptTurn: vi.fn(), readTurn, readTurnExecutionState },
      'https://h5cs.1rying.com',
      1,
    );
    @Module({
      controllers: [PublicTurnController],
      providers: [
        { provide: PublicTurnService, useValue: turns },
        { provide: PublicSessionService, useValue: new PublicSessionService(null, true) },
      ],
    })
    class RuntimeEventsTestModule {}
    const app = await NestFactory.create(RuntimeEventsTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    return {
      app,
      base: await app.getUrl(),
      first,
      completed,
      readTurn,
      readTurnExecutionState,
      order,
    };
  };
  const eventText = (result: { state: string }): string =>
    `event: ${result.state}\ndata: ${JSON.stringify(result)}\n\n`;

  it.each(['runnable', 'paused', 'draining'] as const)(
    'includes the initial execution state %s in real SSE HTTP headers after authorization',
    async (state) => {
      const fixture = await streamFixture(state);
      try {
        const response = await fetch(
          `${fixture.base}/api/v1/public/sessions/${handle}/turns/${turnId}/events`,
          { headers: { Accept: 'text/event-stream', Cookie: `__Host-h5cs_visitor=${nonce}` } },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get(EXECUTION_STATE_HEADER)).toBe(state);
        expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe(eventText(fixture.first) + eventText(fixture.completed));
        expect(fixture.readTurnExecutionState).toHaveBeenCalledOnce();
        expect(fixture.order).toEqual(['read', 'execution', 'read']);
      } finally {
        await fixture.app.close();
      }
    },
  );

  it.each(['completed', 'failed'] as const)(
    'returns not-applicable on a real SSE request whose first result is already %s',
    async (state) => {
      const fixture = await streamFixture('not-applicable', state);
      try {
        const response = await fetch(
          `${fixture.base}/api/v1/public/sessions/${handle}/turns/${turnId}/events`,
          { headers: { Cookie: `__Host-h5cs_visitor=${nonce}` } },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get(EXECUTION_STATE_HEADER)).toBe('not-applicable');
        expect(await response.text()).toBe(eventText(fixture.first));
        expect(fixture.readTurn).toHaveBeenCalledOnce();
        expect(fixture.order).toEqual(['read', 'execution']);
      } finally {
        await fixture.app.close();
      }
    },
  );

  it.each(['unavailable', new Error('ER_NO_SUCH_TABLE synthetic control schema failure')] as const)(
    'keeps real SSE available with an unavailable execution header when control reads fail: %s',
    async (state) => {
      const fixture = await streamFixture(state);
      try {
        const response = await fetch(
          `${fixture.base}/api/v1/public/sessions/${handle}/turns/${turnId}/events`,
          { headers: { Cookie: `__Host-h5cs_visitor=${nonce}` } },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get(EXECUTION_STATE_HEADER)).toBe('unavailable');
        expect(await response.text()).toBe(eventText(fixture.first) + eventText(fixture.completed));
        expect(fixture.order).toEqual(['read', 'execution', 'read']);
      } finally {
        await fixture.app.close();
      }
    },
  );

  it.each([
    { name: 'missing visitor', cookie: '', session: handle, turn: turnId, reads: 0 },
    {
      name: 'duplicate visitor',
      cookie: `__Host-h5cs_visitor=${nonce}; __Host-h5cs_visitor=${Buffer.alloc(32, 1).toString('base64url')}`,
      session: handle,
      turn: turnId,
      reads: 0,
    },
    {
      name: 'another visitor',
      cookie: `__Host-h5cs_visitor=${Buffer.alloc(32, 1).toString('base64url')}`,
      session: handle,
      turn: turnId,
      reads: 1,
    },
    {
      name: 'another session',
      cookie: `__Host-h5cs_visitor=${nonce}`,
      session: `s_${'99'.repeat(16)}`,
      turn: turnId,
      reads: 1,
    },
    {
      name: 'another turn',
      cookie: `__Host-h5cs_visitor=${nonce}`,
      session: handle,
      turn: `t_${'99'.repeat(16)}`,
      reads: 1,
    },
  ])('never queries or reveals execution state over HTTP for $name', async (input) => {
    const fixture = await streamFixture('paused');
    try {
      const response = await fetch(
        `${fixture.base}/api/v1/public/sessions/${input.session}/turns/${input.turn}/events`,
        { headers: { Accept: 'text/event-stream', Cookie: input.cookie } },
      );
      expect(response.status).toBe(404);
      expect(response.headers.get(EXECUTION_STATE_HEADER)).toBeNull();
      expect(response.headers.get('content-type')).not.toContain('text/event-stream');
      expect(await response.text()).not.toContain('paused');
      expect(fixture.readTurn).toHaveBeenCalledTimes(input.reads);
      expect(fixture.readTurnExecutionState).not.toHaveBeenCalled();
    } finally {
      await fixture.app.close();
    }
  });
});
