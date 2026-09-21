import type { VerifiedExternalIdentity } from '@h5cs/domain';

export const MCP_SCOPE = 'mcp:tools' as const;

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

export type OAuthPublicClient = Readonly<{
  clientId: string;
  clientName?: string | undefined;
  redirectUris: readonly string[];
  createdAt: Date;
}>;

export type OAuthAuthorizationCodeRecord = Readonly<{
  codeDigest: Uint8Array;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: typeof MCP_SCOPE;
  codeChallenge: string;
  bindingId: string;
  expiresAt: Date;
  createdAt: Date;
}>;

export type OAuthRefreshTokenRecord = Readonly<{
  tokenDigest: Uint8Array;
  familyId: string;
  clientId: string;
  bindingId: string;
  resource: string;
  scope: typeof MCP_SCOPE;
  expiresAt: Date;
  createdAt: Date;
}>;

export type OAuthRefreshTokenReplacement = Readonly<{
  tokenDigest: Uint8Array;
  expiresAt: Date;
  createdAt: Date;
}>;

export type OAuthRefreshTokenContext = Readonly<{
  clientId: string;
  resource: string;
  scope: typeof MCP_SCOPE;
}>;

export type OAuthRefreshRotationResult =
  | Readonly<{ status: 'rotated'; previous: OAuthRefreshTokenRecord }>
  | Readonly<{ status: 'invalid' | 'replayed' }>;

export type McpAccessTokenClaims = Readonly<{
  subject: string;
  clientId: string;
  scope: typeof MCP_SCOPE;
  expiresAt: number;
}>;

export interface OAuthRepository {
  assertReady(): Promise<void>;
  registerPublicClient(client: OAuthPublicClient): Promise<void>;
  findPublicClient(clientId: string): Promise<OAuthPublicClient | null>;
  storeAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<void>;
  /** Atomically marks an unexpired code used and returns it at most once. */
  consumeAuthorizationCode(
    codeDigest: Uint8Array,
    now: Date,
  ): Promise<OAuthAuthorizationCodeRecord | null>;
  storeRefreshToken(record: OAuthRefreshTokenRecord): Promise<void>;
  /**
   * Atomically validates the client/resource/scope and rotates an active token. Reuse or a context
   * mismatch must revoke the whole family before returning a failure.
   */
  rotateRefreshToken(
    tokenDigest: Uint8Array,
    replacement: OAuthRefreshTokenReplacement,
    expected: OAuthRefreshTokenContext,
    now: Date,
  ): Promise<OAuthRefreshRotationResult>;
}

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
