export const oauthMcpScope = 'mcp:tools' as const;

export class OAuthRepositoryUnavailableError extends Error {
  public constructor(message = 'OAuth persistence is unavailable') {
    super(message);
    this.name = 'OAuthRepositoryUnavailableError';
  }
}

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
  scope: typeof oauthMcpScope;
  codeChallenge: string;
  bindingId: string;
  /** Required by durable MySQL persistence; omitted callers must fail closed. */
  consentGrantId?: string | undefined;
  expiresAt: Date;
  createdAt: Date;
}>;

export type OAuthRefreshTokenRecord = Readonly<{
  tokenDigest: Uint8Array;
  familyId: string;
  clientId: string;
  bindingId: string;
  /** Required by durable MySQL persistence; omitted callers must fail closed. */
  consentGrantId?: string | undefined;
  resource: string;
  scope: typeof oauthMcpScope;
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
  scope: typeof oauthMcpScope;
}>;

export type OAuthRefreshRotationResult =
  | Readonly<{ status: 'rotated'; previous: OAuthRefreshTokenRecord }>
  | Readonly<{ status: 'invalid' | 'replayed' }>;

export interface OAuthRepository {
  assertReady(): Promise<void>;
  registerPublicClient(client: OAuthPublicClient): Promise<void>;
  findPublicClient(clientId: string): Promise<OAuthPublicClient | null>;
  storeAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<void>;
  consumeAuthorizationCode(
    codeDigest: Uint8Array,
    now: Date,
  ): Promise<OAuthAuthorizationCodeRecord | null>;
  storeRefreshToken(record: OAuthRefreshTokenRecord): Promise<void>;
  /**
   * Implementations must validate context and rotate in one transaction. Reuse or context mismatch
   * revokes the whole family before returning a failure.
   */
  rotateRefreshToken(
    tokenDigest: Uint8Array,
    replacement: OAuthRefreshTokenReplacement,
    expected: OAuthRefreshTokenContext,
    now: Date,
  ): Promise<OAuthRefreshRotationResult>;
}
