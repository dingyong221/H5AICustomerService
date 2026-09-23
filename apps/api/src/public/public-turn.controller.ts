import { Body, Controller, Get, Headers, HttpCode, Param, Post, Res } from '@nestjs/common';

import type { ResponseLike } from '../http-types.js';
import { PublicTurnService } from './public-turn.service.js';

@Controller('/api/v1/public/sessions')
export class PublicTurnController {
  public constructor(private readonly turns: PublicTurnService) {}

  @Post('/:sessionHandle/messages')
  @HttpCode(202)
  public async send(
    @Param('sessionHandle') sessionHandle: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.turns.send({ sessionHandle, idempotencyKey, body });
  }

  @Get('/:sessionHandle/turns/:turnId')
  public async read(
    @Param('sessionHandle') sessionHandle: string,
    @Param('turnId') turnId: string,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.turns.read(sessionHandle, turnId);
  }
}
