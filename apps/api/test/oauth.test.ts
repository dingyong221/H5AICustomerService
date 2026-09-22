import { createHash } from 'node:crypto';

import { SignJWT, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  oauthAuthorizationServerMetadataSchema,
  oauthProtectedResourceMetadataSchema,
  oauthTokenResponseSchema,
} from '@h5cs/contracts';
import { OAuthRepositoryUnavailableError, type VerifiedExternalIdentity } from '@h5cs/domain';

import { JoseAccessTokenCodec } from '../src/oauth/jose-access-token-codec.js';
import { McpAccessTokenAuthenticator } from '../src/oauth/mcp-access-token-authenticator.js';
import { OAuthAuthorizationServer } from '../src/oauth/oauth-authorization-server.js';
import { OAuthProtocolError } from '../src/oauth/oauth-errors.js';
import { OAuthController } from '../src/oauth/oauth.controller.js';
import { createRuntimeOAuth, loadOAuthServerConfig } from '../src/oauth/oauth-runtime.js';
import type {
  OAuthAuthorizationContext,
  OAuthAuthorizationCodeRecord,
  OAuthIdentityBindingResolver,
  OAuthPublicClient,
  OAuthRefreshRotationResult,
  OAuthRefreshTokenContext,
  OAuthRefreshTokenRecord,
  OAuthRefreshTokenReplacement,
  OAuthRepository,
  OAuthResourceOwnerAuthorizer,
} from '../src/oauth/oauth-types.js';
import { WorkBuddyAuthenticationRequiredError } from '../src/skill/workbuddy-authenticator.js';

const config = {
  issuer: 'https://h5cs.example.test',
  resource: 'https://h5cs.example.test/mcp',
  authorizationEndpoint: 'https://h5cs.example.test/oauth/authorize',
  tokenEndpoint: 'https://h5cs.example.test/oauth/token',
  registrationEndpoint: 'https://h5cs.example.test/oauth/register',
  accessTokenTtlSeconds: 600,
  authorizationCodeTtlSeconds: 60,
  refreshTokenTtlSeconds: 2_592_000,
} as const;

const digestKey = (value: Uint8Array): string => Buffer.from(value).toString('hex');

class TestOAuthRepository implements OAuthRepository {
  readonly clients = new Map<string, OAuthPublicClient>();
  readonly codes = new Map<string, { record: OAuthAuthorizationCodeRecord; consumed: boolean }>();
  readonly refreshTokens = new Map<string, { record: OAuthRefreshTokenRecord; used: boolean }>();
  readonly revokedFamilies = new Set<string>();

  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async registerPublicClient(client: OAuthPublicClient): Promise<void> {
    await Promise.resolve();
    this.clients.set(client.clientId, client);
  }

  public async findPublicClient(clientId: string): Promise<OAuthPublicClient | null> {
    await Promise.resolve();
    return this.clients.get(clientId) ?? null;
  }

  public async storeAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<void> {
    await Promise.resolve();
    this.codes.set(digestKey(record.codeDigest), { record, consumed: false });
  }

  public async consumeAuthorizationCode(
    codeDigest: Uint8Array,
    now: Date,
  ): Promise<OAuthAuthorizationCodeRecord | null> {
    await Promise.resolve();
    const stored = this.codes.get(digestKey(codeDigest));
    if (
      stored === undefined ||
      stored.consumed ||
      stored.record.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    stored.consumed = true;
    return stored.record;
  }

  public async storeRefreshToken(record: OAuthRefreshTokenRecord): Promise<void> {
    await Promise.resolve();
    this.refreshTokens.set(digestKey(record.tokenDigest), { record, used: false });
  }

  public async rotateRefreshToken(
    tokenDigest: Uint8Array,
    replacement: OAuthRefreshTokenReplacement,
    expected: OAuthRefreshTokenContext,
    now: Date,
  ): Promise<OAuthRefreshRotationResult> {
    await Promise.resolve();
    const stored = this.refreshTokens.get(digestKey(tokenDigest));
    if (stored === undefined) return { status: 'invalid' };
    if (stored.used || this.revokedFamilies.has(stored.record.familyId)) {
      this.revokedFamilies.add(stored.record.familyId);
      return { status: 'replayed' };
    }
    if (stored.record.expiresAt.getTime() <= now.getTime()) return { status: 'invalid' };
    if (
      stored.record.clientId !== expected.clientId ||
      stored.record.resource !== expected.resource ||
      stored.record.scope !== expected.scope
    ) {
      this.revokedFamilies.add(stored.record.familyId);
      return { status: 'invalid' };
    }
    stored.used = true;
    const next: OAuthRefreshTokenRecord = {
      ...stored.record,
      ...replacement,
      familyId: stored.record.familyId,
    };
    this.refreshTokens.set(digestKey(next.tokenDigest), { record: next, used: false });
    return { status: 'rotated', previous: stored.record };
  }
}

class TestResourceOwner implements OAuthResourceOwnerAuthorizer {
  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async resolveAuthorizationSession(
    _cookieHeader: string | undefined,
    context: OAuthAuthorizationContext,
  ): Promise<{ bindingId: string }> {
    await Promise.resolve();
    if (context.resource !== config.resource || context.scope !== 'mcp:tools') {
      throw new Error('Unexpected authorization consent context');
    }
    return { bindingId: 'binding_server_controlled_123' };
  }
}

const identity: VerifiedExternalIdentity = {
  provider: 'workbuddy',
  issuer: 'https://workbuddy.example.test',
  audience: 'h5cs-resource-owner-login',
  subjectLookupKey: new Uint8Array(32).fill(7),
  subjectLookupKeyVersion: 1,
  phoneMatchVerifiedAt: null,
  verifiedAt: new Date('2026-09-21T00:00:00.000Z'),
};

class TestBindingResolver implements OAuthIdentityBindingResolver {
  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async resolve(
    bindingId: string,
    context: OAuthAuthorizationContext,
  ): Promise<VerifiedExternalIdentity> {
    await Promise.resolve();
    if (
      bindingId !== 'binding_server_controlled_123' ||
      context.resource !== config.resource ||
      context.scope !== 'mcp:tools'
    ) {
      throw new WorkBuddyAuthenticationRequiredError();
    }
    return identity;
  }
}

const createTestServer = async () => {
  const keys = await generateKeyPair('ES256');
  const codec = new JoseAccessTokenCodec({
    issuer: config.issuer,
    audience: config.resource,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    keyId: 'oauth-test-key',
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
  });
  const repository = new TestOAuthRepository();
  return {
    keys,
    codec,
    repository,
    server: new OAuthAuthorizationServer(config, repository, codec),
  };
};

const registerAndAuthorize = async (
  server: OAuthAuthorizationServer,
  repository?: TestOAuthRepository,
) => {
  const client = await server.registerPublicClient({
    redirect_uris: ['http://127.0.0.1:43123/oauth/callback'],
    client_name: 'Local MCP client',
    token_endpoint_auth_method: 'none',
  });
  const verifier = 'local-verifier-'.padEnd(64, 'v');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const redirect = await server.authorize(
    {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0] ?? '',
      scope: 'mcp:tools',
      state: 'opaque-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: config.resource,
    },
    new TestResourceOwner(),
    'secure-session-cookie',
  );
  const callback = new URL(redirect);
  const code = callback.searchParams.get('code');
  if (code === null) throw new Error('Missing authorization code');
  if (repository !== undefined) {
    expect([...repository.codes.keys()]).not.toContain(code);
    expect([...repository.codes.keys()][0]).toHaveLength(64);
  }
  return { client, verifier, code, callback };
};

describe('OAuth 2.1 and MCP bearer boundary', () => {
  it('publishes RFC 8414 and RFC 9728 metadata', async () => {
    const { server } = await createTestServer();
    expect(
      oauthAuthorizationServerMetadataSchema.parse(server.authorizationServerMetadata()),
    ).toBeDefined();
    expect(oauthProtectedResourceMetadataSchema.parse(server.protectedResourceMetadata())).toEqual(
      expect.objectContaining({ resource: config.resource }),
    );
  });

  it('completes public registration and one-time Authorization Code + PKCE S256', async () => {
    const { server, codec, repository } = await createTestServer();
    const { client, verifier, code, callback } = await registerAndAuthorize(server, repository);
    expect(callback.searchParams.get('state')).toBe('opaque-state');
    expect(callback.searchParams.get('iss')).toBe(config.issuer);

    const token = await server.exchangeToken({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: client.redirect_uris[0] ?? '',
      code_verifier: verifier,
      resource: config.resource,
    });
    expect(oauthTokenResponseSchema.parse(token).token_type).toBe('Bearer');
    await expect(codec.verify(token.access_token)).resolves.toMatchObject({
      subject: 'binding_server_controlled_123',
      clientId: client.client_id,
      scope: 'mcp:tools',
    });

    await expect(
      server.exchangeToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: client.redirect_uris[0] ?? '',
        code_verifier: verifier,
        resource: config.resource,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('consumes a code on a bad verifier and never permits a later retry', async () => {
    const { server } = await createTestServer();
    const { client, verifier, code } = await registerAndAuthorize(server);
    const request = {
      grant_type: 'authorization_code' as const,
      client_id: client.client_id,
      code,
      redirect_uri: client.redirect_uris[0] ?? '',
      resource: config.resource,
    };

    await expect(
      server.exchangeToken({ ...request, code_verifier: 'wrong-verifier-'.padEnd(64, 'x') }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    await expect(
      server.exchangeToken({ ...request, code_verifier: verifier }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('rotates refresh tokens and revokes the family on replay', async () => {
    const { server } = await createTestServer();
    const { client, verifier, code } = await registerAndAuthorize(server);
    const initial = await server.exchangeToken({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: client.redirect_uris[0] ?? '',
      code_verifier: verifier,
      resource: config.resource,
    });
    const rotated = await server.exchangeToken({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: initial.refresh_token,
      resource: config.resource,
    });
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);

    await expect(
      server.exchangeToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: initial.refresh_token,
        resource: config.resource,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
    await expect(
      server.exchangeToken({
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: rotated.refresh_token,
        resource: config.resource,
      }),
    ).rejects.toMatchObject({ error: 'invalid_grant' });
  });

  it('validates local MCP issuer, audience, token use, scope, and server-side binding', async () => {
    const { server, codec, keys } = await createTestServer();
    const { client, verifier, code } = await registerAndAuthorize(server);
    const token = await server.exchangeToken({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: client.redirect_uris[0] ?? '',
      code_verifier: verifier,
      resource: config.resource,
    });
    const authenticator = new McpAccessTokenAuthenticator(
      codec,
      new TestBindingResolver(),
      config.resource,
    );
    await expect(
      authenticator.authenticateAccessToken(`Bearer ${token.access_token}`),
    ).resolves.toEqual(identity);

    const upstreamToken = await new SignJWT({
      token_use: 'workbuddy_open_api',
      client_id: client.client_id,
      scope: 'mcp:tools',
      resource: config.resource,
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'oauth-test-key' })
      .setIssuer(config.issuer)
      .setAudience(config.resource)
      .setSubject('binding_server_controlled_123')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(keys.privateKey);
    await expect(authenticator.authenticateAccessToken(`Bearer ${upstreamToken}`)).rejects.toThrow(
      WorkBuddyAuthenticationRequiredError,
    );

    const wrongAudience = new JoseAccessTokenCodec({
      issuer: config.issuer,
      audience: 'https://workbuddy.example.test/open-api',
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      keyId: 'oauth-test-key',
      accessTokenTtlSeconds: 600,
    });
    const foreignToken = await wrongAudience.issue({
      subject: 'binding_server_controlled_123',
      clientId: client.client_id,
      scope: 'mcp:tools',
    });
    await expect(authenticator.authenticateAccessToken(`Bearer ${foreignToken}`)).rejects.toThrow(
      WorkBuddyAuthenticationRequiredError,
    );
  });

  it('rejects unregistered redirects, non-MCP resources, and non-HTTPS remote callbacks', async () => {
    const { server } = await createTestServer();
    for (const redirectUri of [
      'http://evil.example.test/oauth/callback',
      'http://localhost:43123/oauth/callback',
      'https://workbuddy.example.test/oauth/callback',
      'http://127.0.0.1:43123/other-callback',
      'workbuddy://workbuddy/mcp/connector%3Aunconfigured/oauth/callback',
    ]) {
      await expect(
        server.registerPublicClient({ redirect_uris: [redirectUri] }),
      ).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
    }

    const { client, verifier, code } = await registerAndAuthorize(server);
    await expect(
      server.exchangeToken({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: client.redirect_uris[0] ?? '',
        code_verifier: verifier,
        resource: 'https://workbuddy.example.test/open-api',
      }),
    ).rejects.toMatchObject({ error: 'invalid_target' });
  });

  it('accepts only the exact configured WorkBuddy private callback', async () => {
    const { repository, codec } = await createTestServer();
    const server = new OAuthAuthorizationServer(
      { ...config, workbuddyConnectorSource: 'h5-ai-customer-service' },
      repository,
      codec,
    );
    const expected = 'workbuddy://workbuddy/mcp/connector%3Ah5-ai-customer-service/oauth/callback';

    await expect(server.registerPublicClient({ redirect_uris: [expected] })).resolves.toMatchObject(
      {
        redirect_uris: [expected],
        token_endpoint_auth_method: 'none',
      },
    );
    await expect(
      server.registerPublicClient({
        redirect_uris: ['workbuddy://workbuddy/mcp/connector%3Aother-source/oauth/callback'],
      }),
    ).rejects.toMatchObject({ error: 'invalid_redirect_uri' });
  });

  it('keeps runtime writes and bearer validation fail-closed without real adapters', async () => {
    const runtime = createRuntimeOAuth({ OAUTH_ISSUER: 'http://localhost:3000' });
    await expect(
      runtime.server.registerPublicClient({
        redirect_uris: ['http://127.0.0.1:43123/oauth/callback'],
      }),
    ).rejects.toMatchObject({
      error: 'temporarily_unavailable',
      statusCode: 503,
    });
    await expect(runtime.authenticator.assertReady()).rejects.toMatchObject({
      name: 'WorkBuddyAuthenticationUnavailableError',
    });
    expect(loadOAuthServerConfig({}).resource).toBe('http://localhost:3000/mcp');
    expect(() => loadOAuthServerConfig({ NODE_ENV: 'production' })).toThrow(
      'OAUTH_ISSUER is required in production',
    );
    expect(() =>
      loadOAuthServerConfig({
        OAUTH_ISSUER: 'https://h5cs.example.test/oauth',
      }),
    ).toThrow('OAUTH_ISSUER must be HTTPS');
  });

  it('maps a configured repository readiness failure to a safe 503', async () => {
    class FailedRepository extends TestOAuthRepository {
      public override async assertReady(): Promise<never> {
        await Promise.resolve();
        throw new OAuthRepositoryUnavailableError('database details must stay private');
      }
    }

    const { codec } = await createTestServer();
    const server = new OAuthAuthorizationServer(config, new FailedRepository(), codec);
    await expect(
      server.registerPublicClient({
        redirect_uris: ['http://127.0.0.1:43123/oauth/callback'],
      }),
    ).rejects.toMatchObject({
      error: 'temporarily_unavailable',
      message: 'OAuth service is not configured',
      statusCode: 503,
    });
  });

  it('serves metadata without the global API envelope and returns standard OAuth errors', async () => {
    const runtime = createRuntimeOAuth({ OAUTH_ISSUER: 'http://localhost:3000' });
    const controller = new OAuthController(runtime);
    let statusCode = 200;
    let body: unknown;
    const response = {
      setHeader: () => undefined,
      status: (status: number) => {
        statusCode = status;
        return response;
      },
      json: (value: unknown) => {
        body = value;
        return value;
      },
      redirect: (_status: number, _url: string) => undefined,
    };

    controller.authorizationServerMetadata(response);
    expect(body).toMatchObject({ issuer: 'http://localhost:3000' });
    expect(body).not.toHaveProperty('data');

    await controller.register(
      'application/json',
      { redirect_uris: ['http://localhost/cb'] },
      response,
    );
    expect(statusCode).toBe(503);
    expect(body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'OAuth service is not configured',
    });
  });

  it('uses stable protocol error objects without exposing adapter details', () => {
    const error = new OAuthProtocolError('invalid_grant', 'Refresh token is invalid');
    expect(error.toResponse()).toEqual({
      error: 'invalid_grant',
      error_description: 'Refresh token is invalid',
    });
  });
});
