import { HttpStatus } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { PublicSessionService } from '../src/public/public-session.service.js';
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
      expect(response.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(resumed.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(history.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(resumed.headers.get('cache-control')).toBe('no-store');
      expect(history.headers.get('cache-control')).toBe('no-store');
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
      expect(sent.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(read.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(sent.headers.get('cache-control')).toBe('no-store');
      expect(read.headers.get('cache-control')).toBe('no-store');
    } finally {
      await app.close();
      if (previous === undefined) delete process.env['PUBLIC_CONVERSATION_ENABLED'];
      else process.env['PUBLIC_CONVERSATION_ENABLED'] = previous;
    }
  });
});
