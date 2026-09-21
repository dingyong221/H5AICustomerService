import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  OAuthAuthorizationRequest,
  OAuthClientRegistrationRequest,
  OAuthClientRegistrationResponse,
  OAuthTokenRequest,
  OAuthTokenResponse,
} from '@h5cs/contracts';
import { OAuthRepositoryUnavailableError } from '@h5cs/domain';

import {
  OAuthProtocolError,
  OAuthResourceOwnerUnavailableError,
  OAuthStorageUnavailableError,
  OAuthTokenCodecUnavailableError,
} from './oauth-errors.js';
import type {
  OAuthAccessTokenCodec,
  OAuthAuthorizationCodeRecord,
  OAuthPublicClient,
  OAuthRefreshTokenRecord,
  OAuthRepository,
  OAuthResourceOwnerAuthorizer,
  OAuthServerConfig,
} from './oauth-types.js';
import { MCP_SCOPE } from './oauth-types.js';

const opaqueToken = (): string => randomBytes(32).toString('base64url');
const digestToken = (value: string): Uint8Array => createHash('sha256').update(value).digest();

const isSafeRedirectUri = (
  value: string,
  workbuddyConnectorSource: string | undefined,
): boolean => {
  const url = new URL(value);
  if (
    url.hash.length > 0 ||
    url.search.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return false;
  }
  if (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.port.length > 0 &&
    url.pathname === '/oauth/callback'
  ) {
    return true;
  }
  if (workbuddyConnectorSource === undefined) return false;
  return (
    value === `workbuddy://workbuddy/mcp/connector%3A${workbuddyConnectorSource}/oauth/callback`
  );
};

const pkceMatches = (verifier: string, challenge: string): boolean => {
  const actual = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const actualBytes = Buffer.from(actual, 'ascii');
  const expectedBytes = Buffer.from(challenge, 'ascii');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

export class OAuthAuthorizationServer {
  readonly #config: OAuthServerConfig;
  readonly #repository: OAuthRepository;
  readonly #accessTokens: OAuthAccessTokenCodec;
  readonly #clock: () => Date;

  public constructor(
    config: OAuthServerConfig,
    repository: OAuthRepository,
    accessTokens: OAuthAccessTokenCodec,
    clock: () => Date = () => new Date(),
  ) {
    this.#config = config;
    this.#repository = repository;
    this.#accessTokens = accessTokens;
    this.#clock = clock;
  }

  public get issuer(): string {
    return this.#config.issuer;
  }

  public authorizationServerMetadata() {
    return {
      issuer: this.#config.issuer,
      authorization_endpoint: this.#config.authorizationEndpoint,
      token_endpoint: this.#config.tokenEndpoint,
      registration_endpoint: this.#config.registrationEndpoint,
      response_types_supported: ['code'] as const,
      grant_types_supported: ['authorization_code', 'refresh_token'] as const,
      code_challenge_methods_supported: ['S256'] as const,
      token_endpoint_auth_methods_supported: ['none'] as const,
      scopes_supported: [MCP_SCOPE] as const,
      authorization_response_iss_parameter_supported: true as const,
    };
  }

  public protectedResourceMetadata() {
    return {
      resource: this.#config.resource,
      authorization_servers: [this.#config.issuer],
      scopes_supported: [MCP_SCOPE] as const,
      bearer_methods_supported: ['header'] as const,
      resource_name: 'H5 AI Customer Service MCP',
    };
  }

  public async registerPublicClient(
    request: OAuthClientRegistrationRequest,
  ): Promise<OAuthClientRegistrationResponse> {
    await this.#assertRuntimeReady(false);
    if (
      request.redirect_uris.some(
        (uri) => !isSafeRedirectUri(uri, this.#config.workbuddyConnectorSource),
      )
    ) {
      throw new OAuthProtocolError(
        'invalid_redirect_uri',
        'redirect_uris must be the configured WorkBuddy callback or an explicit 127.0.0.1 loopback callback',
      );
    }
    const redirectUris = [...new Set(request.redirect_uris)];
    if (redirectUris.length !== request.redirect_uris.length) {
      throw new OAuthProtocolError('invalid_redirect_uri', 'redirect_uris must be unique');
    }
    if (
      request.grant_types !== undefined &&
      (request.grant_types.length !== 2 ||
        !request.grant_types.includes('authorization_code') ||
        !request.grant_types.includes('refresh_token'))
    ) {
      throw new OAuthProtocolError(
        'invalid_client_metadata',
        'grant_types must include authorization_code and refresh_token',
      );
    }

    const now = this.#clock();
    const client: OAuthPublicClient = {
      clientId: opaqueToken(),
      ...(request.client_name === undefined ? {} : { clientName: request.client_name }),
      redirectUris,
      createdAt: now,
    };
    await this.#repository.registerPublicClient(client);
    return {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1_000),
      redirect_uris: redirectUris,
      ...(client.clientName === undefined ? {} : { client_name: client.clientName }),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_SCOPE,
    };
  }

  public async authorize(
    request: OAuthAuthorizationRequest,
    resourceOwner: OAuthResourceOwnerAuthorizer,
    cookieHeader: string | undefined,
  ): Promise<string> {
    await this.#assertRuntimeReady(true);
    const client = await this.#requireClient(request.client_id);
    if (!client.redirectUris.includes(request.redirect_uri)) {
      throw new OAuthProtocolError('invalid_request', 'redirect_uri is not registered');
    }
    const redirect = { redirectUri: request.redirect_uri, state: request.state };
    if (request.resource !== this.#config.resource) {
      throw new OAuthProtocolError(
        'invalid_target',
        'The requested resource is not supported',
        400,
        redirect,
      );
    }

    let bindingId: string;
    try {
      await resourceOwner.assertReady();
      ({ bindingId } = await resourceOwner.resolveAuthorizationSession(cookieHeader, {
        clientId: client.clientId,
        resource: request.resource,
        scope: MCP_SCOPE,
      }));
    } catch (error) {
      if (error instanceof OAuthResourceOwnerUnavailableError) {
        throw new OAuthProtocolError(
          'temporarily_unavailable',
          'Resource-owner authorization is unavailable',
          503,
          redirect,
        );
      }
      throw error;
    }
    if (bindingId.trim().length === 0) {
      throw new OAuthProtocolError('access_denied', 'Authorization was denied', 403, redirect);
    }

    const code = opaqueToken();
    const now = this.#clock();
    const record: OAuthAuthorizationCodeRecord = {
      codeDigest: digestToken(code),
      clientId: client.clientId,
      redirectUri: request.redirect_uri,
      resource: request.resource,
      scope: MCP_SCOPE,
      codeChallenge: request.code_challenge,
      bindingId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#config.authorizationCodeTtlSeconds * 1_000),
    };
    await this.#repository.storeAuthorizationCode(record);

    const callback = new URL(request.redirect_uri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('iss', this.#config.issuer);
    if (request.state !== undefined) callback.searchParams.set('state', request.state);
    return callback.toString();
  }

  public async exchangeToken(request: OAuthTokenRequest): Promise<OAuthTokenResponse> {
    await this.#assertRuntimeReady(true);
    if (request.resource !== this.#config.resource) {
      throw new OAuthProtocolError('invalid_target', 'The requested resource is not supported');
    }
    await this.#requireClient(request.client_id);
    return request.grant_type === 'authorization_code'
      ? this.#exchangeAuthorizationCode(request)
      : this.#rotateRefreshToken(request);
  }

  async #exchangeAuthorizationCode(
    request: Extract<OAuthTokenRequest, { grant_type: 'authorization_code' }>,
  ): Promise<OAuthTokenResponse> {
    const now = this.#clock();
    const code = await this.#repository.consumeAuthorizationCode(digestToken(request.code), now);
    if (
      code === null ||
      code.clientId !== request.client_id ||
      code.redirectUri !== request.redirect_uri ||
      code.resource !== request.resource ||
      code.expiresAt.getTime() <= now.getTime() ||
      !pkceMatches(request.code_verifier, code.codeChallenge)
    ) {
      throw new OAuthProtocolError('invalid_grant', 'Authorization code is invalid or expired');
    }

    const refreshToken = opaqueToken();
    const refreshRecord: OAuthRefreshTokenRecord = {
      tokenDigest: digestToken(refreshToken),
      familyId: opaqueToken(),
      clientId: code.clientId,
      bindingId: code.bindingId,
      resource: code.resource,
      scope: code.scope,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#config.refreshTokenTtlSeconds * 1_000),
    };
    await this.#repository.storeRefreshToken(refreshRecord);
    return this.#issueTokenResponse(code.bindingId, code.clientId, refreshToken);
  }

  async #rotateRefreshToken(
    request: Extract<OAuthTokenRequest, { grant_type: 'refresh_token' }>,
  ): Promise<OAuthTokenResponse> {
    const now = this.#clock();
    const replacement = opaqueToken();
    const result = await this.#repository.rotateRefreshToken(
      digestToken(request.refresh_token),
      {
        tokenDigest: digestToken(replacement),
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.#config.refreshTokenTtlSeconds * 1_000),
      },
      {
        clientId: request.client_id,
        resource: request.resource,
        scope: request.scope ?? MCP_SCOPE,
      },
      now,
    );
    if (
      result.status !== 'rotated' ||
      result.previous.clientId !== request.client_id ||
      result.previous.resource !== request.resource ||
      result.previous.scope !== (request.scope ?? MCP_SCOPE) ||
      result.previous.expiresAt.getTime() <= now.getTime()
    ) {
      throw new OAuthProtocolError(
        'invalid_grant',
        'Refresh token is invalid, expired, or replayed',
      );
    }
    return this.#issueTokenResponse(
      result.previous.bindingId,
      result.previous.clientId,
      replacement,
    );
  }

  async #issueTokenResponse(
    bindingId: string,
    clientId: string,
    refreshToken: string,
  ): Promise<OAuthTokenResponse> {
    const accessToken = await this.#accessTokens.issue({
      subject: bindingId,
      clientId,
      scope: MCP_SCOPE,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.#config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: MCP_SCOPE,
    };
  }

  async #requireClient(clientId: string): Promise<OAuthPublicClient> {
    const client = await this.#repository.findPublicClient(clientId);
    if (client === null) throw new OAuthProtocolError('invalid_client', 'Unknown public client');
    return client;
  }

  async #assertRuntimeReady(requireTokenCodec: boolean): Promise<void> {
    try {
      await this.#repository.assertReady();
      if (requireTokenCodec) await this.#accessTokens.assertReady();
    } catch (error) {
      if (
        error instanceof OAuthStorageUnavailableError ||
        error instanceof OAuthRepositoryUnavailableError ||
        error instanceof OAuthTokenCodecUnavailableError
      ) {
        throw new OAuthProtocolError(
          'temporarily_unavailable',
          'OAuth service is not configured',
          503,
        );
      }
      throw error;
    }
  }
}
