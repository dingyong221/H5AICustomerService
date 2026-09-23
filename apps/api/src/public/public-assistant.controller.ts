import { Controller, Get, Param, Res } from '@nestjs/common';

import type { ResponseLike } from '../http-types.js';
import { PublicAssistantService } from './public-assistant.service.js';

@Controller('/api/v1/public/assistants')
export class PublicAssistantController {
  public constructor(private readonly service: PublicAssistantService) {}

  @Get('/:publicSlug')
  public async load(
    @Param('publicSlug') publicSlug: string,
    @Res({ passthrough: true }) response: ResponseLike,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.load(publicSlug);
  }
}
