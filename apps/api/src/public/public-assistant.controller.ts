import { Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';

import type { ResponseLike } from '../http-types.js';
import { PublicAssistantService } from './public-assistant.service.js';
import { PublicSessionService } from './public-session.service.js';

@Controller('/api/v1/public/assistants')
export class PublicAssistantController {
  public constructor(
    private readonly service: PublicAssistantService,
    private readonly sessions: PublicSessionService,
  ) {}

  @Get('/:publicSlug')
  public async load(
    @Param('publicSlug') publicSlug: string,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.load(publicSlug);
  }

  @Post('/:publicSlug/sessions')
  public async createSession(
    @Param('publicSlug') publicSlug: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const created = await this.sessions.create({ publicSlug, idempotencyKey, cookieHeader });
    if (created.setCookie) response.setHeader('Set-Cookie', created.setCookie);
    return created.session;
  }
}
