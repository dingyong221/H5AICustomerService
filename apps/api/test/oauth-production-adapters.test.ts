import { createHash } from 'node:crypto';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  ConnectorBindingResolution,
  PlatformLoginSessionRecord,
  PlatformLoginSessionRepository,
} from '@h5cs/domain';
import {
  toExternalIdentityId,
  toMerchantId,
  toMerchantUserId,
  type VerifiedExternalIdentity,
} from '@h5cs/domain';

import { RepositoryOAuthIdentityBindingResolver } from '../src/oauth/oauth-identity-binding-resolver.js';
import { loadProductionOAuthAdapters } from '../src/oauth/oauth-production-adapters.js';
import { createRuntimeOAuth } from '../src/oauth/oauth-runtime.js';
import { RepositoryPlatformLoginService } from '../src/oauth/platform-login-service.js';
import {
  WorkBuddyLocalAuthorizationUnavailableError,
  WorkBuddyMutationContextInvalidError,
} from '../src/oauth/workbuddy-local-authorization.service.js';
import {
  OAuthAccessTokenInvalidError,
  OAuthIdentityBindingUnavailableError,
} from '../src/oauth/oauth-errors.js';
import type { OAuthAuthorizationContext } from '../src/oauth/oauth-types.js';

const now = new Date('2026-09-21T12:00:00.000Z');
const sessionToken = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const cookieName = '__Host-h5cs_session';
const origin = 'https://h5cs.example.test';
const merchantUserId = toMerchantUserId('11'.repeat(16));
const sha256 = (value: string): Uint8Array => createHash('sha256').update(value, 'ascii').digest();
const captureError = async (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => new Error('Expected promise to reject'),
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

const sessionRecord = (
  overrides: Partial<PlatformLoginSessionRecord> = {},
): PlatformLoginSessionRecord => ({
  sessionDigest: sha256(sessionToken),
  merchantUserId,
  csrfDigest: sha256(csrfToken),
  authenticationLevel: 'primary',
  authenticatedAt: new Date('2026-09-21T11:00:00.000Z'),
  expiresAt: new Date('2026-09-21T13:00:00.000Z'),
  revokedAt: null,
  createdAt: new Date('2026-09-21T11:00:00.000Z'),
  updatedAt: new Date('2026-09-21T11:00:00.000Z'),
  ...overrides,
});

class TestPlatformLoginRepository implements PlatformLoginSessionRepository {
  public record: PlatformLoginSessionRecord | null = sessionRecord();
  public failure: Error | null = null;
  public readonly reads: Uint8Array[] = [];
  public readonly mutations: Readonly<{ session: Uint8Array; csrf: Uint8Array }>[] = [];

  public async assertReady(): Promise<void> {
    await Promise.resolve();
    if (this.failure !== null) throw this.failure;
  }

  public async storePlatformLoginSession(_record: PlatformLoginSessionRecord): Promise<void> {
    await Promise.resolve();
  }

  public async resolvePlatformLoginSession(
    sessionDigest: Uint8Array,
    _now: Date,
  ): Promise<PlatformLoginSessionRecord | null> {
    await Promise.resolve();
    this.reads.push(sessionDigest);
    if (this.failure !== null) throw this.failure;
    return this.record;
  }

  public async resolvePlatformMutationSession(
    sessionDigest: Uint8Array,
    csrfDigest: Uint8Array,
    _now: Date,
  ): Promise<PlatformLoginSessionRecord | null> {
    await Promise.resolve();
    this.mutations.push({ session: sessionDigest, csrf: csrfDigest });
    if (this.failure !== null) throw this.failure;
    return this.record;
  }

  public async revokePlatformLoginSession(
    _sessionDigest: Uint8Array,
    _now: Date,
  ): Promise<boolean> {
    await Promise.resolve();
    return false;
  }
}

const createLogin = (repository = new TestPlatformLoginRepository()) => ({
  repository,
  service: new RepositoryPlatformLoginService(
    repository,
    { cookieName, allowedOrigins: [origin], production: true },
    () => now,
  ),
});

const identity: VerifiedExternalIdentity = {
  provider: 'workbuddy',
  issuer: 'https://workbuddy.example.test',
  audience: 'platform-login-client',
  subjectLookupKey: new Uint8Array(32).fill(7),
  subjectLookupKeyVersion: 1,
  phoneMatchVerifiedAt: null,
  verifiedAt: new Date('2026-09-21T11:30:00.000Z'),
};

const bindingId = 'binding_opaque_123';
const bindingContext = {
  clientId: 'oauth-public-client',
  resource: 'https://h5cs.example.test/mcp',
  scope: 'mcp:tools',
} as const;
const bindingResolution = (
  overrides: Partial<ConnectorBindingResolution> = {},
): ConnectorBindingResolution => ({
  grantId: 'grant_opaque_123',
  bindingId,
  merchantUserId,
  externalIdentityId: toExternalIdentityId('22'.repeat(16)),
  merchantId: toMerchantId('33'.repeat(16)),
  clientId: bindingContext.clientId,
  resource: bindingContext.resource,
  scope: bindingContext.scope,
  identity,
  ...overrides,
});

class TestBindingRepository {
  public active: ConnectorBindingResolution | null = bindingResolution();
  public failure: Error | null = null;
  public calls = 0;

  public async assertReady(): Promise<void> {
    await Promise.resolve();
    if (this.failure !== null) throw this.failure;
  }

  public async resolveActiveBinding(
    _bindingId: string,
    _now: Date,
  ): Promise<ConnectorBindingResolution | null> {
    await Promise.resolve();
    this.calls += 1;
    if (this.failure !== null) throw this.failure;
    return this.active;
  }
}

describe('production platform login adapter', () => {
  it('hashes opaque cookie and CSRF values before online repository lookup', async () => {
    const { repository, service } = createLogin();
    await expect(
      service.resolveSession(`theme=dark; ${cookieName}=${sessionToken}`),
    ).resolves.toMatchObject({ accountId: merchantUserId, merchantUserId });
    await expect(
      service.resolveMutationSession({
        cookieHeader: `${cookieName}=${sessionToken}`,
        csrfToken,
        origin,
      }),
    ).resolves.toMatchObject({ accountId: merchantUserId, merchantUserId });

    expect(Buffer.from(repository.reads[0] ?? [])).toEqual(Buffer.from(sha256(sessionToken)));
    expect(Buffer.from(repository.mutations[0]?.session ?? [])).toEqual(
      Buffer.from(sha256(sessionToken)),
    );
    expect(Buffer.from(repository.mutations[0]?.csrf ?? [])).toEqual(
      Buffer.from(sha256(csrfToken)),
    );
    expect(repository.reads[0]).not.toContain(sessionToken);
  });

  it('rejects duplicate, injected, malformed, missing and overlong cookies before lookup', async () => {
    const { repository, service } = createLogin();
    const invalidHeaders = [
      `${cookieName}=${sessionToken}; ${cookieName}=${'x'.repeat(43)}`,
      `${cookieName}=${sessionToken}\r\nInjected: yes`,
      `${cookieName}=short`,
      `${cookieName}=${'x'.repeat(257)}`,
      `other=${sessionToken}`,
      `${cookieName}=${sessionToken}; other=1; other=2`,
    ];
    for (const header of invalidHeaders) {
      await expect(service.resolveSession(header)).resolves.toBeNull();
    }
    expect(repository.reads).toHaveLength(0);

    await expect(
      service.resolveMutationSession({
        cookieHeader: `${cookieName}=${sessionToken}; ${cookieName}=${sessionToken}`,
        csrfToken,
        origin,
      }),
    ).rejects.toBeInstanceOf(WorkBuddyMutationContextInvalidError);
    expect(repository.mutations).toHaveLength(0);
  });

  it('requires an explicit valid CSRF header and exact configured Origin', async () => {
    const { repository, service } = createLogin();
    for (const context of [
      { cookieHeader: `${cookieName}=${sessionToken}`, csrfToken: undefined, origin },
      { cookieHeader: `${cookieName}=${sessionToken}`, csrfToken: 'short', origin },
      { cookieHeader: `${cookieName}=${sessionToken}`, csrfToken: 'x'.repeat(257), origin },
      {
        cookieHeader: `${cookieName}=${sessionToken}`,
        csrfToken,
        origin: `${origin}/`,
      },
      {
        cookieHeader: `${cookieName}=${sessionToken}`,
        csrfToken,
        origin: 'https://evil.example.test',
      },
    ]) {
      await expect(service.resolveMutationSession(context)).rejects.toBeInstanceOf(
        WorkBuddyMutationContextInvalidError,
      );
    }
    expect(repository.mutations).toHaveLength(0);
  });

  it('rejects expired, revoked and digest-mismatched records even if a repository returns one', async () => {
    const { repository, service } = createLogin();
    for (const record of [
      sessionRecord({ expiresAt: now }),
      sessionRecord({ revokedAt: new Date('2026-09-21T11:45:00.000Z') }),
      sessionRecord({ sessionDigest: new Uint8Array(32).fill(9) }),
      sessionRecord({ csrfDigest: new Uint8Array(32).fill(9) }),
    ]) {
      repository.record = record;
      if (record.csrfDigest[0] === 9) {
        await expect(
          service.resolveMutationSession({
            cookieHeader: `${cookieName}=${sessionToken}`,
            csrfToken,
            origin,
          }),
        ).resolves.toBeNull();
      } else {
        await expect(service.resolveSession(`${cookieName}=${sessionToken}`)).resolves.toBeNull();
      }
    }
  });

  it('redacts repository errors and enforces production cookie/origin configuration', async () => {
    const repository = new TestPlatformLoginRepository();
    repository.failure = new Error(`database failed for ${sessionToken}`);
    const { service } = createLogin(repository);
    const failure = await captureError(service.resolveSession(`${cookieName}=${sessionToken}`));
    expect(failure).toBeInstanceOf(WorkBuddyLocalAuthorizationUnavailableError);
    expect(failure.message).not.toContain(sessionToken);
    expect(
      () =>
        new RepositoryPlatformLoginService(repository, {
          cookieName: 'local_session',
          allowedOrigins: [origin],
          production: true,
        }),
    ).toThrow(WorkBuddyLocalAuthorizationUnavailableError);
    expect(
      () =>
        new RepositoryPlatformLoginService(repository, {
          cookieName,
          allowedOrigins: ['http://localhost:3000'],
          production: true,
        }),
    ).toThrow(WorkBuddyLocalAuthorizationUnavailableError);
    expect(
      () =>
        new RepositoryPlatformLoginService(repository, {
          cookieName: 'local_session',
          allowedOrigins: ['http://localhost:3000'],
          production: false,
        }),
    ).not.toThrow();
  });
});

describe('online OAuth identity binding resolver', () => {
  it('rechecks the active binding on every request and fails immediately after revoke', async () => {
    const repository = new TestBindingRepository();
    const resolver = new RepositoryOAuthIdentityBindingResolver(repository, () => now);
    await expect(resolver.resolve(bindingId, bindingContext)).resolves.toEqual(identity);
    repository.active = null;
    await expect(resolver.resolve(bindingId, bindingContext)).rejects.toBeInstanceOf(
      OAuthAccessTokenInvalidError,
    );
    expect(repository.calls).toBe(2);
  });

  it('requires exact client, resource and scope context and rejects malformed bindings', async () => {
    const repository = new TestBindingRepository();
    const resolver = new RepositoryOAuthIdentityBindingResolver(repository, () => now);
    for (const resolution of [
      bindingResolution({ clientId: 'other-client' }),
      bindingResolution({ resource: 'https://h5cs.example.test/other' }),
      bindingResolution({ bindingId: 'other-binding' }),
    ]) {
      repository.active = resolution;
      await expect(resolver.resolve(bindingId, bindingContext)).rejects.toBeInstanceOf(
        OAuthAccessTokenInvalidError,
      );
    }
    const callsBeforeMalformed = repository.calls;
    await expect(resolver.resolve('bad binding', bindingContext)).rejects.toBeInstanceOf(
      OAuthAccessTokenInvalidError,
    );
    await expect(
      resolver.resolve(bindingId, {
        ...bindingContext,
        scope: 'other-scope',
      } as unknown as OAuthAuthorizationContext),
    ).rejects.toBeInstanceOf(OAuthAccessTokenInvalidError);
    expect(repository.calls).toBe(callsBeforeMalformed);
  });

  it('redacts persistence errors while keeping missing bindings invalid rather than unavailable', async () => {
    const repository = new TestBindingRepository();
    const resolver = new RepositoryOAuthIdentityBindingResolver(repository, () => now);
    repository.active = null;
    await expect(resolver.resolve(bindingId, bindingContext)).rejects.toBeInstanceOf(
      OAuthAccessTokenInvalidError,
    );

    repository.failure = new Error(`database failed for ${bindingId}`);
    const failure = await captureError(resolver.resolve(bindingId, bindingContext));
    expect(failure).toBeInstanceOf(OAuthIdentityBindingUnavailableError);
    expect(failure.message).not.toContain(bindingId);
  });
});

describe('production OAuth adapter factory', () => {
  let directory: string;
  let caFile: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'h5cs-oauth-ca-'));
    caFile = join(directory, 'ca.pem');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nTEST-ONLY\n-----END CERTIFICATE-----\n');
  });

  afterAll(() => {
    unlinkSync(caFile);
    rmdirSync(directory);
  });

  it('configures adapters only when database, cookie and Origin settings are complete', () => {
    const complete = {
      NODE_ENV: 'production',
      MYSQL_DATABASE_URL: 'mysql://service:secret@db.internal/h5cs?ssl-mode=VERIFY_IDENTITY',
      MYSQL_TLS_CA_FILE: caFile,
      PLATFORM_LOGIN_SESSION_COOKIE_NAME: cookieName,
      PLATFORM_LOGIN_ALLOWED_ORIGINS: origin,
    };
    expect(loadProductionOAuthAdapters(complete).configured).toBe(true);
    expect(
      loadProductionOAuthAdapters({ ...complete, MYSQL_DATABASE_URL: undefined }).configured,
    ).toBe(false);
    expect(
      loadProductionOAuthAdapters({
        ...complete,
        PLATFORM_LOGIN_SESSION_COOKIE_NAME: undefined,
      }).configured,
    ).toBe(false);
    expect(
      loadProductionOAuthAdapters({
        ...complete,
        PLATFORM_LOGIN_ALLOWED_ORIGINS: 'https://h5cs.example.test/',
      }).configured,
    ).toBe(false);
  });

  it('keeps the runtime unavailable while signing and resource-owner adapters are absent', async () => {
    const environment = {
      NODE_ENV: 'production',
      OAUTH_ISSUER: origin,
      MYSQL_DATABASE_URL: 'mysql://service:secret@db.internal/h5cs?ssl-mode=VERIFY_IDENTITY',
      MYSQL_TLS_CA_FILE: caFile,
      PLATFORM_LOGIN_SESSION_COOKIE_NAME: cookieName,
      PLATFORM_LOGIN_ALLOWED_ORIGINS: origin,
    };
    const runtime = createRuntimeOAuth(environment);
    await expect(runtime.authenticator.assertReady()).rejects.toMatchObject({
      name: 'WorkBuddyAuthenticationUnavailableError',
    });
    await expect(runtime.resourceOwner.assertReady()).rejects.toMatchObject({
      name: 'OAuthResourceOwnerUnavailableError',
    });
  });
});
