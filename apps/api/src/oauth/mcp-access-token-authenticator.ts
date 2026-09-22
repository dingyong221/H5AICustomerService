import type { VerifiedExternalIdentity } from '@h5cs/domain';

import type { WorkBuddyAuthenticator } from '../skill/workbuddy-authenticator.js';
import {
  WorkBuddyAuthenticationRequiredError,
  WorkBuddyAuthenticationUnavailableError,
} from '../skill/workbuddy-authenticator.js';
import {
  OAuthAccessTokenInvalidError,
  OAuthIdentityBindingUnavailableError,
  OAuthTokenCodecUnavailableError,
} from './oauth-errors.js';
import type { OAuthAccessTokenCodec, OAuthIdentityBindingResolver } from './oauth-types.js';

const bearerPattern = /^Bearer ([^\s]{1,4096})$/u;

export class McpAccessTokenAuthenticator implements WorkBuddyAuthenticator {
  readonly #accessTokens: OAuthAccessTokenCodec;
  readonly #bindings: OAuthIdentityBindingResolver;
  readonly #resource: string;

  public constructor(
    accessTokens: OAuthAccessTokenCodec,
    bindings: OAuthIdentityBindingResolver,
    resource: string,
  ) {
    this.#accessTokens = accessTokens;
    this.#bindings = bindings;
    this.#resource = resource;
  }

  public async assertReady(): Promise<void> {
    try {
      await this.#accessTokens.assertReady();
      await this.#bindings.assertReady();
    } catch (error) {
      if (
        error instanceof OAuthTokenCodecUnavailableError ||
        error instanceof OAuthIdentityBindingUnavailableError
      ) {
        throw new WorkBuddyAuthenticationUnavailableError(
          'MCP OAuth access-token verification is not configured',
        );
      }
      throw error;
    }
  }

  public async authenticateAccessToken(
    authorizationHeader: string,
  ): Promise<VerifiedExternalIdentity> {
    const match = bearerPattern.exec(authorizationHeader);
    if (match === null) throw new WorkBuddyAuthenticationRequiredError();
    const token = match[1];
    if (token === undefined) throw new WorkBuddyAuthenticationRequiredError();

    try {
      const claims = await this.#accessTokens.verify(token);
      return await this.#bindings.resolve(claims.subject, {
        clientId: claims.clientId,
        resource: this.#resource,
        scope: claims.scope,
      });
    } catch (error) {
      if (error instanceof OAuthAccessTokenInvalidError) {
        throw new WorkBuddyAuthenticationRequiredError();
      }
      if (
        error instanceof OAuthTokenCodecUnavailableError ||
        error instanceof OAuthIdentityBindingUnavailableError
      ) {
        throw new WorkBuddyAuthenticationUnavailableError(
          'MCP OAuth access-token verification is not configured',
        );
      }
      throw error;
    }
  }
}
