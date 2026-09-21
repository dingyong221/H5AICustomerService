import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { WorkBuddyMcpAdapter } from './workbuddy-mcp.adapter.js';

@Injectable()
export class WorkBuddyMcpMiddleware implements NestMiddleware {
  public constructor(private readonly adapter: WorkBuddyMcpAdapter) {}

  public async use(
    request: IncomingMessage,
    response: ServerResponse,
    _next: () => void,
  ): Promise<void> {
    await this.adapter.handleRequest(request, response);
  }
}
