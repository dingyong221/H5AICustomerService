import { Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';

import type { ResponseLike } from '../http-types.js';
import { PublicAssistantService } from './public-assistant.service.js';
import { PublicSessionService } from './public-session.service.js';
import { publicSnapshotForClient } from './public-client-features.js';

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
    @Headers('x-h5cs-features') features?: string,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'X-H5CS-Features');
    return publicSnapshotForClient(await this.service.load(publicSlug), features);
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

  @Get('/:publicSlug/sessions/:sessionRequestId')
  public async resumeSession(
    @Param('publicSlug') publicSlug: string,
    @Param('sessionRequestId') sessionRequestId: string,
    @Headers('cookie') cookieHeader: string | undefined,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.sessions.resume({ publicSlug, sessionRequestId, cookieHeader });
  }
}
