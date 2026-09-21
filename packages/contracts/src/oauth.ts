import { z } from 'zod';

export const oauthScopeSchema = z.enum(['mcp:tools']);

export const oauthAuthorizationServerMetadataSchema = z
  .object({
    issuer: z.string().url(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    registration_endpoint: z.string().url(),
    response_types_supported: z.tuple([z.literal('code')]),
    grant_types_supported: z.tuple([z.literal('authorization_code'), z.literal('refresh_token')]),
    code_challenge_methods_supported: z.tuple([z.literal('S256')]),
    token_endpoint_auth_methods_supported: z.tuple([z.literal('none')]),
    scopes_supported: z.tuple([z.literal('mcp:tools')]),
    authorization_response_iss_parameter_supported: z.literal(true),
  })
  .strict();

export const oauthProtectedResourceMetadataSchema = z
  .object({
    resource: z.string().url(),
    authorization_servers: z.array(z.string().url()).min(1),
    scopes_supported: z.tuple([z.literal('mcp:tools')]),
    bearer_methods_supported: z.tuple([z.literal('header')]),
    resource_name: z.string().min(1),
  })
  .strict();

const redirectUriSchema = z.string().url().max(2_048);

export const oauthClientRegistrationRequestSchema = z
  .object({
    redirect_uris: z.array(redirectUriSchema).min(1).max(10),
    client_name: z.string().trim().min(1).max(200).optional(),
    token_endpoint_auth_method: z.literal('none').optional(),
    grant_types: z
      .array(z.enum(['authorization_code', 'refresh_token']))
      .min(1)
      .max(2)
      .optional(),
    response_types: z.tuple([z.literal('code')]).optional(),
    scope: z.literal('mcp:tools').optional(),
  })
  .strict();

export const oauthClientRegistrationResponseSchema = z
  .object({
    client_id: z.string().min(16).max(256),
    client_id_issued_at: z.number().int().nonnegative(),
    redirect_uris: z.array(redirectUriSchema).min(1),
    client_name: z.string().min(1).max(200).optional(),
    token_endpoint_auth_method: z.literal('none'),
    grant_types: z.tuple([z.literal('authorization_code'), z.literal('refresh_token')]),
    response_types: z.tuple([z.literal('code')]),
    scope: z.literal('mcp:tools'),
  })
  .strict();

export const oauthAuthorizationRequestSchema = z
  .object({
    response_type: z.literal('code'),
    client_id: z.string().min(16).max(256),
    redirect_uri: redirectUriSchema,
    scope: z.literal('mcp:tools'),
    state: z.string().min(1).max(512),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    code_challenge_method: z.literal('S256'),
    resource: z.string().url().max(2_048),
  })
  .strict();

const authorizationCodeTokenRequestSchema = z
  .object({
    grant_type: z.literal('authorization_code'),
    client_id: z.string().min(16).max(256),
    code: z.string().min(32).max(512),
    redirect_uri: redirectUriSchema,
    code_verifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/u),
    resource: z.string().url().max(2_048),
  })
  .strict();

const refreshTokenRequestSchema = z
  .object({
    grant_type: z.literal('refresh_token'),
    client_id: z.string().min(16).max(256),
    refresh_token: z.string().min(32).max(512),
    resource: z.string().url().max(2_048),
    scope: z.literal('mcp:tools').optional(),
  })
  .strict();

export const oauthTokenRequestSchema = z.discriminatedUnion('grant_type', [
  authorizationCodeTokenRequestSchema,
  refreshTokenRequestSchema,
]);

export const oauthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(32),
    scope: z.literal('mcp:tools'),
  })
  .strict();

export const oauthErrorResponseSchema = z
  .object({
    error: z.enum([
      'invalid_request',
      'invalid_client',
      'invalid_client_metadata',
      'invalid_redirect_uri',
      'invalid_grant',
      'unauthorized_client',
      'unsupported_response_type',
      'unsupported_grant_type',
      'invalid_scope',
      'invalid_target',
      'server_error',
      'temporarily_unavailable',
      'access_denied',
    ]),
    error_description: z.string().min(1).max(512).optional(),
  })
  .strict();

export type OAuthAuthorizationRequest = z.infer<typeof oauthAuthorizationRequestSchema>;
export type OAuthClientRegistrationRequest = z.infer<typeof oauthClientRegistrationRequestSchema>;
export type OAuthClientRegistrationResponse = z.infer<typeof oauthClientRegistrationResponseSchema>;
export type OAuthTokenRequest = z.infer<typeof oauthTokenRequestSchema>;
export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;
export type OAuthErrorResponse = z.infer<typeof oauthErrorResponseSchema>;
