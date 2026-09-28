import { Body, Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';

import type { EventStreamResponseLike, ResponseLike } from '../http-types.js';
import { PublicSessionService } from './public-session.service.js';
import { PublicTurnService } from './public-turn.service.js';

@Controller('/api/v1/public/sessions')
export class PublicTurnController {
  public constructor(
    private readonly turns: PublicTurnService,
    private readonly sessions: PublicSessionService,
  ) {}

  @Get('/:sessionHandle/history')
  public async history(
    @Param('sessionHandle') sessionHandle: string,
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.sessions.history(sessionHandle, cookieHeader);
  }

  @Post('/:sessionHandle/end')
  @HttpCode(200)
  public async end(
    @Param('sessionHandle') sessionHandle: string,
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.sessions.end(sessionHandle, cookieHeader);
  }

  @Post('/:sessionHandle/messages')
  @HttpCode(202)
  public async send(
    @Param('sessionHandle') sessionHandle: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('cookie') cookieHeader: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.turns.send({
      sessionHandle,
      visitorNonce: this.sessions.visitorNonce(cookieHeader),
      idempotencyKey,
      body,
    });
  }

  @Get('/:sessionHandle/turns/:turnId')
  public async read(
    @Param('sessionHandle') sessionHandle: string,
    @Param('turnId') turnId: string,
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.turns.read(sessionHandle, this.sessions.visitorNonce(cookieHeader), turnId);
  }

  @Get('/:sessionHandle/turns/:turnId/events')
  public async events(
    @Param('sessionHandle') sessionHandle: string,
    @Param('turnId') turnId: string,
    @Headers('cookie') cookieHeader: string | undefined,
    @Res() response: EventStreamResponseLike,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const visitorNonce = this.sessions.visitorNonce(cookieHeader);
    const first = await this.turns.read(sessionHandle, visitorNonce, turnId);
    const disconnected = new AbortController();
    response.on('close', () => disconnected.abort());
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(90_000)]);
    const keepalive = setInterval(() => {
      if (signal.aborted) return;
      try {
        response.write(': keepalive\n\n');
      } catch {
        disconnected.abort();
      }
    }, 15_000);
    const writeResult = (result: typeof first): void => {
      response.write(`event: ${result.state}\ndata: ${JSON.stringify(result)}\n\n`);
    };
    try {
      writeResult(first);
      for await (const result of this.turns.stream(
        sessionHandle,
        visitorNonce,
        turnId,
        signal,
        first,
      )) {
        writeResult(result);
      }
    } catch {
      if (!signal.aborted) response.write('event: unavailable\ndata: {}\n\n');
    } finally {
      clearInterval(keepalive);
      if (!disconnected.signal.aborted) response.end();
    }
  }
}
