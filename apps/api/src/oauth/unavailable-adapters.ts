import type {
  McpAccessTokenClaims,
  OAuthAccessTokenCodec,
  OAuthAuthorizationContext,
  OAuthAuthorizationCodeRecord,
  OAuthIdentityBindingResolver,
  OAuthPublicClient,
  OAuthRefreshRotationResult,
  OAuthRefreshTokenContext,
  OAuthRefreshTokenReplacement,
  OAuthRefreshTokenRecord,
  OAuthRepository,
  OAuthResourceOwnerAuthorizer,
} from './oauth-types.js';
import {
  OAuthIdentityBindingUnavailableError,
  OAuthResourceOwnerUnavailableError,
  OAuthStorageUnavailableError,
  OAuthTokenCodecUnavailableError,
} from './oauth-errors.js';

export class UnavailableOAuthRepository implements OAuthRepository {
  readonly #reason: string;

  public constructor(reason = 'OAuth persistence adapter is not configured') {
    this.#reason = reason;
  }

  public async assertReady(): Promise<never> {
    return this.#fail();
  }

  public async registerPublicClient(_client: OAuthPublicClient): Promise<never> {
    return this.#fail();
  }

  public async findPublicClient(_clientId: string): Promise<never> {
    return this.#fail();
  }

  public async storeAuthorizationCode(_record: OAuthAuthorizationCodeRecord): Promise<never> {
    return this.#fail();
  }

  public async consumeAuthorizationCode(_codeDigest: Uint8Array, _now: Date): Promise<never> {
    return this.#fail();
  }

  public async storeRefreshToken(_record: OAuthRefreshTokenRecord): Promise<never> {
    return this.#fail();
  }

  public async rotateRefreshToken(
    _tokenDigest: Uint8Array,
    _replacement: OAuthRefreshTokenReplacement,
    _expected: OAuthRefreshTokenContext,
    _now: Date,
  ): Promise<OAuthRefreshRotationResult> {
    return this.#fail();
  }

  async #fail(): Promise<never> {
    await Promise.resolve();
    throw new OAuthStorageUnavailableError(this.#reason);
  }
}

export class UnavailableOAuthAccessTokenCodec implements OAuthAccessTokenCodec {
  public async assertReady(): Promise<never> {
    return this.#fail();
  }

  public async issue(_claims: Omit<McpAccessTokenClaims, 'expiresAt'>): Promise<never> {
    return this.#fail();
  }

  public async verify(_token: string): Promise<never> {
    return this.#fail();
  }

  async #fail(): Promise<never> {
    await Promise.resolve();
    throw new OAuthTokenCodecUnavailableError();
  }
}

export class UnavailableOAuthIdentityBindingResolver implements OAuthIdentityBindingResolver {
  readonly #reason: string;

  public constructor(reason = 'OAuth identity binding resolution is not configured') {
    this.#reason = reason;
  }

  public async assertReady(): Promise<never> {
    return this.#fail();
  }

  public async resolve(_bindingId: string, _context: OAuthAuthorizationContext): Promise<never> {
    return this.#fail();
  }

  async #fail(): Promise<never> {
    await Promise.resolve();
    throw new OAuthIdentityBindingUnavailableError(this.#reason);
  }
}

export class UnavailableOAuthResourceOwnerAuthorizer implements OAuthResourceOwnerAuthorizer {
  public async assertReady(): Promise<never> {
    return this.#fail();
  }

  public async resolveAuthorizationSession(
    _cookieHeader: string | undefined,
    _context: OAuthAuthorizationContext,
  ): Promise<never> {
    return this.#fail();
  }

  async #fail(): Promise<never> {
    await Promise.resolve();
    throw new OAuthResourceOwnerUnavailableError();
  }
}
