import { Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

import { MCP_SCOPE } from './oauth-types.js';
import { OAuthRuntime } from './oauth-runtime.js';

type BearerMiddleware = ReturnType<typeof requireBearerAuth>;

@Injectable()
export class McpBearerAuthMiddleware implements NestMiddleware {
  readonly #middleware: ReturnType<typeof requireBearerAuth>;

  public constructor(runtime: OAuthRuntime) {
    this.#middleware = requireBearerAuth({
      verifier: runtime.tokenVerifier,
      requiredScopes: [MCP_SCOPE],
      resourceMetadataUrl: runtime.protectedResourceMetadataUrl,
    });
  }

  public use(request: unknown, response: unknown, next: () => void): void {
    void this.#middleware(
      request as Parameters<BearerMiddleware>[0],
      response as Parameters<BearerMiddleware>[1],
      next,
    );
  }
}
