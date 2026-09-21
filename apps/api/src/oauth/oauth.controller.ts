import { Body, Controller, Get, Headers, Post, Query, Res } from '@nestjs/common';

import {
  oauthAuthorizationRequestSchema,
  oauthClientRegistrationRequestSchema,
  oauthTokenRequestSchema,
} from '@h5cs/contracts';

import { OAuthProtocolError } from './oauth-errors.js';
import { OAuthRuntime } from './oauth-runtime.js';

type OAuthHttpResponse = {
  setHeader(name: string, value: string): void;
  status(statusCode: number): OAuthHttpResponse;
  json(body: unknown): unknown;
  redirect(statusCode: number, url: string): unknown;
};

const noStore = (response: OAuthHttpResponse): void => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : {};

@Controller()
export class OAuthController {
  public constructor(private readonly runtime: OAuthRuntime) {}

  @Get('/.well-known/oauth-authorization-server')
  public authorizationServerMetadata(@Res() response: OAuthHttpResponse): void {
    response.json(this.runtime.server.authorizationServerMetadata());
  }

  @Get('/.well-known/oauth-protected-resource')
  public protectedResourceMetadata(@Res() response: OAuthHttpResponse): void {
    response.json(this.runtime.server.protectedResourceMetadata());
  }

  @Get('/.well-known/oauth-protected-resource/mcp')
  public mcpProtectedResourceMetadata(@Res() response: OAuthHttpResponse): void {
    response.json(this.runtime.server.protectedResourceMetadata());
  }

  @Post('/oauth/register')
  public async register(
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
    @Res() response: OAuthHttpResponse,
  ): Promise<void> {
    noStore(response);
    if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      this.#writeError(
        response,
        new OAuthProtocolError('invalid_request', 'Content-Type must be application/json'),
      );
      return;
    }
    const parsed = oauthClientRegistrationRequestSchema.safeParse(body);
    if (!parsed.success) {
      this.#writeError(
        response,
        new OAuthProtocolError('invalid_client_metadata', 'Invalid client metadata'),
      );
      return;
    }
    try {
      response.status(201).json(await this.runtime.server.registerPublicClient(parsed.data));
    } catch (error) {
      this.#writeUnknownError(response, error);
    }
  }

  @Get('/oauth/authorize')
  public async authorize(
    @Query() query: unknown,
    @Headers('cookie') cookieHeader: string | undefined,
    @Res() response: OAuthHttpResponse,
  ): Promise<void> {
    noStore(response);
    const parsed = oauthAuthorizationRequestSchema.safeParse(query);
    if (!parsed.success) {
      const raw = asRecord(query);
      const error =
        raw.response_type !== undefined && raw.response_type !== 'code'
          ? new OAuthProtocolError(
              'unsupported_response_type',
              'Only code response_type is supported',
            )
          : raw.scope !== undefined && raw.scope !== 'mcp:tools'
            ? new OAuthProtocolError('invalid_scope', 'Only mcp:tools scope is supported')
            : new OAuthProtocolError('invalid_request', 'Invalid authorization request');
      this.#writeError(response, error);
      return;
    }
    try {
      const redirect = await this.runtime.server.authorize(
        parsed.data,
        this.runtime.resourceOwner,
        cookieHeader,
      );
      response.redirect(302, redirect);
    } catch (error) {
      this.#writeUnknownError(response, error);
    }
  }

  @Post('/oauth/token')
  public async token(
    @Headers('content-type') contentType: string | undefined,
    @Headers('authorization') authorizationHeader: string | undefined,
    @Body() body: unknown,
    @Res() response: OAuthHttpResponse,
  ): Promise<void> {
    noStore(response);
    if (authorizationHeader !== undefined) {
      this.#writeError(
        response,
        new OAuthProtocolError(
          'invalid_client',
          'Public clients must not authenticate with a secret',
        ),
      );
      return;
    }
    if (
      contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded'
    ) {
      this.#writeError(
        response,
        new OAuthProtocolError(
          'invalid_request',
          'Content-Type must be application/x-www-form-urlencoded',
        ),
      );
      return;
    }
    const parsed = oauthTokenRequestSchema.safeParse(body);
    if (!parsed.success) {
      const raw = asRecord(body);
      const error =
        raw.grant_type !== undefined &&
        raw.grant_type !== 'authorization_code' &&
        raw.grant_type !== 'refresh_token'
          ? new OAuthProtocolError('unsupported_grant_type', 'Unsupported grant_type')
          : raw.scope !== undefined && raw.scope !== 'mcp:tools'
            ? new OAuthProtocolError('invalid_scope', 'Only mcp:tools scope is supported')
            : new OAuthProtocolError('invalid_request', 'Invalid token request');
      this.#writeError(response, error);
      return;
    }
    try {
      response.json(await this.runtime.server.exchangeToken(parsed.data));
    } catch (error) {
      this.#writeUnknownError(response, error);
    }
  }

  #writeUnknownError(response: OAuthHttpResponse, error: unknown): void {
    if (error instanceof OAuthProtocolError) {
      this.#writeError(response, error);
      return;
    }
    this.#writeError(response, new OAuthProtocolError('server_error', 'OAuth request failed', 500));
  }

  #writeError(response: OAuthHttpResponse, error: OAuthProtocolError): void {
    if (error.redirectUri !== undefined) {
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set('error', error.error);
      redirect.searchParams.set('error_description', error.message);
      redirect.searchParams.set('iss', this.runtime.server.issuer);
      if (error.state !== undefined) redirect.searchParams.set('state', error.state);
      response.redirect(302, redirect.toString());
      return;
    }
    response.status(error.statusCode).json(error.toResponse());
  }
}
