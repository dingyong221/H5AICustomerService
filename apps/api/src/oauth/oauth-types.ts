import { oauthMcpScope } from '@h5cs/domain';
import type {
  OAuthAuthorizationCodeRecord as DomainOAuthAuthorizationCodeRecord,
  OAuthPublicClient as DomainOAuthPublicClient,
  OAuthRefreshRotationResult as DomainOAuthRefreshRotationResult,
  OAuthRefreshTokenContext as DomainOAuthRefreshTokenContext,
  OAuthRefreshTokenRecord as DomainOAuthRefreshTokenRecord,
  OAuthRefreshTokenReplacement as DomainOAuthRefreshTokenReplacement,
  OAuthRepository as DomainOAuthRepository,
  VerifiedExternalIdentity,
} from '@h5cs/domain';

export const MCP_SCOPE = oauthMcpScope;

export type OAuthServerConfig = Readonly<{
  issuer: string;
  resource: string;
  workbuddyConnectorSource?: string | undefined;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  accessTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}>;

export type OAuthPublicClient = DomainOAuthPublicClient;
export type OAuthAuthorizationCodeRecord = DomainOAuthAuthorizationCodeRecord;
export type OAuthRefreshTokenRecord = DomainOAuthRefreshTokenRecord;
export type OAuthRefreshTokenReplacement = DomainOAuthRefreshTokenReplacement;
export type OAuthRefreshTokenContext = DomainOAuthRefreshTokenContext;
export type OAuthRefreshRotationResult = DomainOAuthRefreshRotationResult;

export type McpAccessTokenClaims = Readonly<{
  subject: string;
  clientId: string;
  scope: typeof MCP_SCOPE;
  expiresAt: number;
}>;

export type OAuthRepository = DomainOAuthRepository;

export interface OAuthAccessTokenCodec {
  assertReady(): Promise<void>;
  issue(claims: Omit<McpAccessTokenClaims, 'expiresAt'>): Promise<string>;
  verify(token: string): Promise<McpAccessTokenClaims>;
}

export interface OAuthIdentityBindingResolver {
  assertReady(): Promise<void>;
  resolve(bindingId: string): Promise<VerifiedExternalIdentity>;
}

export type OAuthAuthorizationContext = Readonly<{
  clientId: string;
  resource: string;
  scope: typeof MCP_SCOPE;
}>;

export interface OAuthResourceOwnerAuthorizer {
  assertReady(): Promise<void>;
  /** Resolves an authenticated session that has explicitly approved this client/resource/scope. */
  resolveAuthorizationSession(
    cookieHeader: string | undefined,
    context: OAuthAuthorizationContext,
  ): Promise<{ bindingId: string }>;
}
