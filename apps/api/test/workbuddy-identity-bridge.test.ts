import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { toMerchantUserId } from '@h5cs/domain';

import {
  WorkBuddyOpenApiClient,
  WorkBuddyOpenApiConfigurationError,
  WorkBuddyOpenApiExchangeError,
  loadWorkBuddyOpenApiClient,
} from '../src/oauth/workbuddy-open-api-client.js';
import {
  WorkBuddyIdentityBridge,
  type WorkBuddyBindingStateRecord,
  type WorkBuddyBindingStateRepository,
} from '../src/oauth/workbuddy-identity-bridge.js';
import { WorkBuddyAuthenticationRequiredError } from '../src/skill/workbuddy-authenticator.js';

const clientConfig = {
  clientId: 'app_h5cs_identity_test',
  clientSecret: 'test-secret-value-that-is-never-real',
  redirectUri: 'https://h5cs.example.test/auth/workbuddy/callback',
  requestedScopes: ['user.contact.readable'],
} as const;

const state = 'state_'.padEnd(48, 'x');
const code = 'authorization-code-value';
const now = new Date('2026-09-21T12:00:00.000Z');

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

class TestStateRepository implements WorkBuddyBindingStateRepository {
  readonly #records = new Map<string, WorkBuddyBindingStateRecord>();

  public add(rawState: string, record: WorkBuddyBindingStateRecord): void {
    this.#records.set(createHash('sha256').update(rawState, 'ascii').digest('hex'), record);
  }

  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async consume(
    stateDigest: Uint8Array,
    _now: Date,
  ): Promise<WorkBuddyBindingStateRecord | null> {
    await Promise.resolve();
    const key = Buffer.from(stateDigest).toString('hex');
    const record = this.#records.get(key) ?? null;
    this.#records.delete(key);
    return record;
  }
}

const tokenPayload = {
  access_token: 'access-token-value-that-is-sensitive',
  token_type: 'Bearer',
  expires_in: 3_600,
  refresh_token: 'refresh-token-value-that-is-sensitive',
  scope: 'user.contact.readable',
  open_id: 'pairwise-open-id-that-is-sensitive',
} as const;

describe('WorkBuddy third-party OAuth identity bridge', () => {
  it('loads only a complete server-side configuration set', () => {
    expect(loadWorkBuddyOpenApiClient({})).toEqual({
      configured: false,
      reason: 'WorkBuddy Open API credentials are not set',
    });
    expect(() =>
      loadWorkBuddyOpenApiClient({ WORKBUDDY_OPEN_API_CLIENT_ID: clientConfig.clientId }),
    ).toThrow(WorkBuddyOpenApiConfigurationError);

    const loaded = loadWorkBuddyOpenApiClient({
      WORKBUDDY_OPEN_API_CLIENT_ID: clientConfig.clientId,
      WORKBUDDY_OPEN_API_CLIENT_SECRET: clientConfig.clientSecret,
      WORKBUDDY_OPEN_API_REDIRECT_URI: clientConfig.redirectUri,
      WORKBUDDY_OPEN_API_SCOPES: clientConfig.requestedScopes.join(' '),
    });
    expect(loaded.configured).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain(clientConfig.clientSecret);
  });

  it('builds the fixed WorkBuddy authorize URL without exposing the client secret', () => {
    const client = new WorkBuddyOpenApiClient(clientConfig, vi.fn());
    const url = new URL(client.buildAuthorizationUrl(state));

    expect(url.origin + url.pathname).toBe('https://www.workbuddy.cn/openapi/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe(clientConfig.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(clientConfig.redirectUri);
    expect(url.searchParams.get('scope')).toBe('user.contact.readable');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.toString()).not.toContain(clientConfig.clientSecret);
  });

  it('exchanges a code only at the fixed server endpoint with an exact callback', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(tokenPayload));
    const client = new WorkBuddyOpenApiClient(clientConfig, fetchMock);
    const result = await client.exchangeAuthorizationCode(code);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, request] = fetchMock.mock.calls[0] ?? [];
    expect(endpoint).toBe('https://www.workbuddy.cn/openapi/v2/token');
    expect(request?.redirect).toBe('error');
    const body = request?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('redirect_uri')).toBe(clientConfig.redirectUri);
    expect(body.get('client_secret')).toBe(clientConfig.clientSecret);
    expect(result.openId).toBe(tokenPayload.open_id);
  });

  it('consumes state once and returns only a HMAC-derived identity', async () => {
    const repository = new TestStateRepository();
    repository.add(state, {
      transactionId: 'binding_transaction_01',
      merchantUserId: toMerchantUserId('00112233445566778899aabbccddeeff'),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const client = new WorkBuddyOpenApiClient(
      clientConfig,
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(tokenPayload)),
    );
    const bridge = new WorkBuddyIdentityBridge({
      client,
      states: repository,
      subjectHmacSecret: new Uint8Array(32).fill(9),
      subjectLookupKeyVersion: 2,
      clock: () => now,
    });

    const result = await bridge.completeAuthorization({ authorizationCode: code, state });
    expect(result.identity).toMatchObject({
      provider: 'workbuddy',
      issuer: 'https://www.workbuddy.cn',
      audience: clientConfig.clientId,
      subjectLookupKeyVersion: 2,
      phoneMatchVerifiedAt: null,
      verifiedAt: now,
    });
    expect(result.identity.subjectLookupKey).toHaveLength(32);
    expect(result.accessTokenExpiresAt).toEqual(new Date(now.getTime() + 3_600_000));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(tokenPayload.open_id);
    expect(serialized).not.toContain(tokenPayload.access_token);
    expect(serialized).not.toContain(tokenPayload.refresh_token);

    await expect(bridge.completeAuthorization({ authorizationCode: code, state })).rejects.toThrow(
      WorkBuddyAuthenticationRequiredError,
    );
  });

  it('consumes state before a failed exchange so ambiguous callbacks cannot be replayed', async () => {
    const repository = new TestStateRepository();
    repository.add(state, {
      transactionId: 'binding_transaction_02',
      merchantUserId: toMerchantUserId('00112233445566778899aabbccddeeff'),
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const client = new WorkBuddyOpenApiClient(
      clientConfig,
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400)),
    );
    const bridge = new WorkBuddyIdentityBridge({
      client,
      states: repository,
      subjectHmacSecret: new Uint8Array(32).fill(9),
      subjectLookupKeyVersion: 1,
      clock: () => now,
    });

    await expect(bridge.completeAuthorization({ authorizationCode: code, state })).rejects.toThrow(
      WorkBuddyOpenApiExchangeError,
    );
    await expect(bridge.completeAuthorization({ authorizationCode: code, state })).rejects.toThrow(
      WorkBuddyAuthenticationRequiredError,
    );
  });

  it('rejects expired or malformed state before exchanging credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(tokenPayload));
    const repository = new TestStateRepository();
    repository.add(state, {
      transactionId: 'binding_transaction_03',
      merchantUserId: toMerchantUserId('00112233445566778899aabbccddeeff'),
      expiresAt: new Date(now.getTime() - 1),
    });
    const bridge = new WorkBuddyIdentityBridge({
      client: new WorkBuddyOpenApiClient(clientConfig, fetchMock),
      states: repository,
      subjectHmacSecret: new Uint8Array(32).fill(9),
      subjectLookupKeyVersion: 1,
      clock: () => now,
    });

    await expect(bridge.completeAuthorization({ authorizationCode: code, state })).rejects.toThrow(
      WorkBuddyAuthenticationRequiredError,
    );
    await expect(
      bridge.completeAuthorization({ authorizationCode: code, state: 'short' }),
    ).rejects.toThrow(WorkBuddyAuthenticationRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on unsafe config and malformed or oversized responses', async () => {
    expect(
      () =>
        new WorkBuddyOpenApiClient({
          ...clientConfig,
          redirectUri: 'http://h5cs.example.test/auth/workbuddy/callback',
        }),
    ).toThrow(WorkBuddyOpenApiConfigurationError);

    const malformed = new WorkBuddyOpenApiClient(
      clientConfig,
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...tokenPayload, open_id: '' })),
    );
    await expect(malformed.exchangeAuthorizationCode(code)).rejects.toThrow(
      WorkBuddyOpenApiExchangeError,
    );

    const overScoped = new WorkBuddyOpenApiClient(
      clientConfig,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse({ ...tokenPayload, scope: 'user.contact.readable user.task.invokable' }),
        ),
    );
    await expect(overScoped.exchangeAuthorizationCode(code)).rejects.toThrow(
      WorkBuddyOpenApiExchangeError,
    );

    const underScoped = new WorkBuddyOpenApiClient(
      { ...clientConfig, requestedScopes: ['user.contact.readable', 'user.profile.readable'] },
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(tokenPayload)),
    );
    await expect(underScoped.exchangeAuthorizationCode(code)).rejects.toThrow(
      WorkBuddyOpenApiExchangeError,
    );

    const oversized = new WorkBuddyOpenApiClient(
      clientConfig,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(65 * 1024) },
        }),
      ),
    );
    await expect(oversized.exchangeAuthorizationCode(code)).rejects.toThrow(
      WorkBuddyOpenApiExchangeError,
    );
  });
});
