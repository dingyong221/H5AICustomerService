import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

import { OAuthAccessTokenInvalidError, OAuthTokenCodecUnavailableError } from './oauth-errors.js';
import type { OAuthAccessTokenCodec } from './oauth-types.js';

export class McpOAuthTokenVerifier implements OAuthTokenVerifier {
  readonly #accessTokens: OAuthAccessTokenCodec;
  readonly #resource: string;

  public constructor(accessTokens: OAuthAccessTokenCodec, resource: string) {
    this.#accessTokens = accessTokens;
    this.#resource = resource;
  }

  public async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const claims = await this.#accessTokens.verify(token);
      return {
        token,
        clientId: claims.clientId,
        scopes: [claims.scope],
        expiresAt: claims.expiresAt,
        resource: new URL(this.#resource),
        extra: { subject_binding: claims.subject },
      };
    } catch (error) {
      if (error instanceof OAuthAccessTokenInvalidError) {
        throw new InvalidTokenError('Invalid MCP access token');
      }
      if (error instanceof OAuthTokenCodecUnavailableError) {
        throw new ServerError('MCP access-token verification is unavailable');
      }
      throw error;
    }
  }
}
