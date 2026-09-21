import { randomUUID } from 'node:crypto';

import type { KeyInput } from 'jose';
import { SignJWT, jwtVerify } from 'jose';

import type { McpAccessTokenClaims, OAuthAccessTokenCodec } from './oauth-types.js';
import { MCP_SCOPE } from './oauth-types.js';
import { OAuthAccessTokenInvalidError } from './oauth-errors.js';

type JoseAccessTokenCodecConfig = Readonly<{
  issuer: string;
  audience: string;
  privateKey: KeyInput;
  publicKey: KeyInput;
  keyId: string;
  accessTokenTtlSeconds: number;
}>;

type McpJwtPayload = Readonly<{
  token_use?: unknown;
  client_id?: unknown;
  scope?: unknown;
  resource?: unknown;
}>;

export class JoseAccessTokenCodec implements OAuthAccessTokenCodec {
  readonly #config: JoseAccessTokenCodecConfig;

  public constructor(config: JoseAccessTokenCodecConfig) {
    this.#config = config;
  }

  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async issue(claims: Omit<McpAccessTokenClaims, 'expiresAt'>): Promise<string> {
    return new SignJWT({
      token_use: 'mcp_access',
      client_id: claims.clientId,
      scope: claims.scope,
      resource: this.#config.audience,
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: this.#config.keyId })
      .setIssuer(this.#config.issuer)
      .setAudience(this.#config.audience)
      .setSubject(claims.subject)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${this.#config.accessTokenTtlSeconds}s`)
      .sign(this.#config.privateKey);
  }

  public async verify(token: string): Promise<McpAccessTokenClaims> {
    try {
      const verified = await jwtVerify<McpJwtPayload>(token, this.#config.publicKey, {
        algorithms: ['ES256'],
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        typ: 'at+jwt',
        requiredClaims: ['sub', 'iat', 'exp', 'aud', 'iss'],
        clockTolerance: 5,
      });
      const payload = verified.payload;
      if (
        payload.token_use !== 'mcp_access' ||
        payload.scope !== MCP_SCOPE ||
        payload.resource !== this.#config.audience ||
        typeof payload.client_id !== 'string' ||
        payload.client_id.length === 0 ||
        typeof payload.sub !== 'string' ||
        payload.sub.length === 0 ||
        typeof payload.exp !== 'number'
      ) {
        throw new OAuthAccessTokenInvalidError();
      }
      return {
        subject: payload.sub,
        clientId: payload.client_id,
        scope: MCP_SCOPE,
        expiresAt: payload.exp,
      };
    } catch (error) {
      if (error instanceof OAuthAccessTokenInvalidError) throw error;
      throw new OAuthAccessTokenInvalidError();
    }
  }
}
