import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { toMerchantUserId, type VerifiedExternalIdentity } from '@h5cs/domain';

import { WorkBuddyLocalAuthorizationController } from '../src/oauth/workbuddy-local-authorization.controller.js';
import { createRuntimeWorkBuddyLocalAuthorization } from '../src/oauth/workbuddy-local-authorization.runtime.js';
import {
  DefaultWorkBuddyLocalAuthorizationService,
  UnavailableWorkBuddyLocalAuthorizationService,
  WorkBuddyAuthorizationTransactionInvalidError,
  WorkBuddyLocalAuthorizationUnavailableError,
  WorkBuddyMutationContextInvalidError,
  type MerchantCandidate,
  type PlatformAuthorizationTransactions,
  type PlatformConsentDecision,
  type PlatformConsentService,
  type PlatformLoginService,
  type PlatformMutationContext,
  type PlatformMerchantCandidateService,
  type PlatformPendingAuthorization,
} from '../src/oauth/workbuddy-local-authorization.service.js';
import {
  WorkBuddyIdentityBridge,
  type WorkBuddyBindingStateRecord,
  type WorkBuddyBindingStateRepository,
  type WorkBuddyBindingStateToStore,
} from '../src/oauth/workbuddy-identity-bridge.js';
import { WorkBuddyOpenApiClient } from '../src/oauth/workbuddy-open-api-client.js';

const now = new Date('2026-09-21T12:00:00.000Z');
const merchantUserId = toMerchantUserId('00112233445566778899aabbccddeeff');
const transactionRef = 'a'.repeat(64);
const otherTransactionRef = 'b'.repeat(64);
const csrfToken = 'csrf_'.padEnd(48, 'x');
const mutationContext: PlatformMutationContext = {
  cookieHeader: 'session=opaque',
  csrfToken,
  origin: 'https://h5cs.example.test',
};
const clientConfig = {
  clientId: 'app_h5cs_local_authorization_test',
  clientSecret: 'test-secret-value-that-is-never-real',
  redirectUri: 'https://h5cs.example.test/api/v1/auth/workbuddy/callback',
  requestedScopes: ['user.contact.readable'],
} as const;

const identity: VerifiedExternalIdentity = {
  provider: 'workbuddy',
  issuer: 'https://www.workbuddy.cn',
  audience: clientConfig.clientId,
  subjectLookupKey: new Uint8Array(32).fill(5),
  subjectLookupKeyVersion: 1,
  phoneMatchVerifiedAt: null,
  verifiedAt: now,
};

class TestBindingStates implements WorkBuddyBindingStateRepository {
  readonly records = new Map<string, WorkBuddyBindingStateRecord>();
  created: WorkBuddyBindingStateToStore | undefined;

  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async store(record: WorkBuddyBindingStateToStore): Promise<void> {
    await Promise.resolve();
    this.created = record;
    this.records.set(Buffer.from(record.stateDigest).toString('hex'), record);
  }

  public async consume(
    stateDigest: Uint8Array,
    loginSessionDigest: Uint8Array,
    _currentTime: Date,
  ): Promise<WorkBuddyBindingStateRecord | null> {
    await Promise.resolve();
    const key = Buffer.from(stateDigest).toString('hex');
    const record = this.records.get(key) ?? null;
    if (
      record === null ||
      !Buffer.from(record.loginSessionDigest).equals(Buffer.from(loginSessionDigest))
    ) {
      return null;
    }
    this.records.delete(key);
    return record;
  }
}

class TestLogin implements PlatformLoginService {
  public available = true;
  public signedIn = true;

  public async assertReady(): Promise<void> {
    await Promise.resolve();
    if (!this.available) throw new WorkBuddyLocalAuthorizationUnavailableError();
  }

  public async resolveSession(cookieHeader?: string) {
    await Promise.resolve();
    return this.signedIn
      ? {
          accountId: 'account_01',
          loginSessionDigest: new Uint8Array(32).fill(cookieHeader === 'session=other' ? 4 : 3),
          merchantUserId,
        }
      : null;
  }

  public async resolveMutationSession(context: PlatformMutationContext) {
    await Promise.resolve();
    if (
      context.origin !== mutationContext.origin ||
      context.csrfToken !== mutationContext.csrfToken
    ) {
      throw new WorkBuddyMutationContextInvalidError();
    }
    return this.resolveSession(context.cookieHeader);
  }
}

class TestTransactions implements PlatformAuthorizationTransactions {
  pending: PlatformPendingAuthorization | null = null;
  boundCandidate: string | undefined;
  bindCalls = 0;
  loginSessionDigest: Uint8Array | undefined;
  statusSessionDigest: Uint8Array | undefined;

  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async begin(session: { loginSessionDigest: Uint8Array }, _bridgeStateDigest: Uint8Array) {
    await Promise.resolve();
    this.loginSessionDigest = session.loginSessionDigest;
    return {
      accountId: 'account_01',
      loginSessionDigest: session.loginSessionDigest,
      merchantUserId,
      transactionRef,
    };
  }

  public async acceptBridgeResult(
    result: {
      transactionId: string;
      identity: VerifiedExternalIdentity;
    },
    session: { loginSessionDigest: Uint8Array },
  ) {
    await Promise.resolve();
    if (
      this.loginSessionDigest === undefined ||
      !Buffer.from(this.loginSessionDigest).equals(Buffer.from(session.loginSessionDigest))
    ) {
      return { status: 'conflict' as const };
    }
    this.pending = {
      accountId: 'account_01',
      identity: result.identity,
      loginSessionDigest: session.loginSessionDigest,
      merchantUserId,
      transactionRef: result.transactionId,
    };
    return { status: 'accepted' as const, pending: this.pending };
  }

  public async findPending(
    session: { loginSessionDigest: Uint8Array; merchantUserId: typeof merchantUserId },
    requestedTransactionRef: string,
  ) {
    await Promise.resolve();
    if (
      this.pending === null ||
      this.pending.transactionRef !== requestedTransactionRef ||
      this.pending.merchantUserId !== session.merchantUserId ||
      !Buffer.from(this.pending.loginSessionDigest).equals(Buffer.from(session.loginSessionDigest))
    ) {
      return null;
    }
    return this.pending;
  }

  public async selectMerchantCandidate(input: {
    candidateRef: string;
    session: { loginSessionDigest: Uint8Array };
    transactionRef: string;
  }) {
    await Promise.resolve();
    if (
      this.pending === null ||
      this.pending.transactionRef !== input.transactionRef ||
      !Buffer.from(this.pending.loginSessionDigest).equals(
        Buffer.from(input.session.loginSessionDigest),
      )
    ) {
      throw new WorkBuddyAuthorizationTransactionInvalidError();
    }
    this.pending = { ...this.pending, selectedCandidateRef: input.candidateRef };
    return this.pending;
  }

  public async bindMerchant(input: {
    candidateRef: string;
    session: { loginSessionDigest: Uint8Array };
    transactionRef: string;
  }) {
    await Promise.resolve();
    if (
      this.pending === null ||
      this.pending.transactionRef !== input.transactionRef ||
      !Buffer.from(this.pending.loginSessionDigest).equals(
        Buffer.from(input.session.loginSessionDigest),
      )
    ) {
      throw new WorkBuddyAuthorizationTransactionInvalidError();
    }
    this.bindCalls += 1;
    this.boundCandidate = input.candidateRef;
    return { status: 'connected' as const };
  }

  public async readStatus(
    _session: { loginSessionDigest: Uint8Array },
    requestedTransactionRef: string | undefined,
  ) {
    await Promise.resolve();
    this.statusSessionDigest = _session.loginSessionDigest;
    return {
      status: 'binding_required' as const,
      transaction_ref: requestedTransactionRef ?? transactionRef,
    };
  }
}

class TestCandidates implements PlatformMerchantCandidateService {
  public values: readonly MerchantCandidate[] = [
    { candidateRef: 'merchant_candidate_01', displayName: '示例商家' },
  ];

  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async listCandidates(): Promise<readonly MerchantCandidate[]> {
    await Promise.resolve();
    return this.values;
  }
}

class TestConsent implements PlatformConsentService {
  public decision: PlatformConsentDecision = 'required';
  public transactionId: string | undefined;
  public candidateRef: string | undefined;
  public getDecisionCalls = 0;
  public recordDecisionCalls = 0;

  public async assertReady(): Promise<void> {
    await Promise.resolve();
  }

  public async getDecision(
    pending: PlatformPendingAuthorization,
    candidateRef: string,
  ): Promise<PlatformConsentDecision> {
    await Promise.resolve();
    this.getDecisionCalls += 1;
    if (this.transactionId !== pending.transactionRef || this.candidateRef !== candidateRef) {
      return 'required';
    }
    return this.decision;
  }

  public async recordDecision(
    pending: PlatformPendingAuthorization,
    candidateRef: string,
    decision: 'grant' | 'deny',
  ): Promise<void> {
    await Promise.resolve();
    this.recordDecisionCalls += 1;
    this.transactionId = pending.transactionRef;
    this.candidateRef = candidateRef;
    this.decision = decision === 'grant' ? 'granted' : 'revoked';
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

const createHarness = () => {
  const states = new TestBindingStates();
  const login = new TestLogin();
  const transactions = new TestTransactions();
  const candidates = new TestCandidates();
  const consent = new TestConsent();
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(tokenPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const client = new WorkBuddyOpenApiClient(clientConfig, fetchMock);
  const bridge = new WorkBuddyIdentityBridge({
    client,
    states,
    subjectHmacSecret: new Uint8Array(32).fill(7),
    subjectLookupKeyVersion: 1,
    configurationId: 'workbuddy_config_01',
    configurationVersion: 1,
    clock: () => now,
  });
  const service = new DefaultWorkBuddyLocalAuthorizationService({
    client,
    bridge,
    states,
    login,
    transactions,
    candidates,
    consent,
    configurationId: 'workbuddy_config_01',
    configurationVersion: 1,
    clock: () => now,
  });
  return { bridge, candidates, consent, fetchMock, login, service, states, transactions };
};

describe('local-account WorkBuddy authorization orchestration', () => {
  it('creates a one-time bridge state and only returns the fixed authorize URL', async () => {
    const { fetchMock, service, states } = createHarness();
    const result = await service.startAuthorization(mutationContext);

    expect(result.status).toBe('signed_in');
    if (result.status !== 'signed_in') throw new Error('Expected signed_in result');
    const authorizationUrl = new URL(result.authorization_url);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      'https://www.workbuddy.cn/openapi/v2/authorize',
    );
    const rawState = authorizationUrl.searchParams.get('state');
    expect(rawState).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(states.created?.stateDigest).toEqual(
      createHash('sha256')
        .update(rawState as string, 'ascii')
        .digest(),
    );
    expect(JSON.stringify(states.created)).not.toContain(rawState);
    expect(states.created?.loginSessionDigest).toEqual(new Uint8Array(32).fill(3));
    expect(states.created?.configurationId).toBe('workbuddy_config_01');
    expect(result.authorization_url).not.toContain(clientConfig.clientSecret);
    expect(result.transaction_ref).toBe(transactionRef);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a real local login but never applies account-level consent before identity bridge', async () => {
    const { consent, login, service, states } = createHarness();
    login.signedIn = false;
    await expect(
      service.startAuthorization({ ...mutationContext, cookieHeader: undefined }),
    ).resolves.toEqual({
      status: 'sign_in_required',
    });
    expect(states.created).toBeUndefined();

    login.signedIn = true;
    await expect(service.startAuthorization(mutationContext)).resolves.toMatchObject({
      status: 'signed_in',
      transaction_ref: transactionRef,
    });
    expect(states.created).toBeDefined();
    expect(consent.getDecisionCalls).toBe(0);
  });

  it('completes code/state on the server and binds a single merchant candidate', async () => {
    const { consent, fetchMock, service, transactions } = createHarness();
    const started = await service.startAuthorization(mutationContext);
    if (started.status !== 'signed_in') throw new Error('Expected signed_in result');
    const state = new URL(started.authorization_url).searchParams.get('state');
    consent.decision = 'granted';
    consent.transactionId = otherTransactionRef;
    consent.candidateRef = 'merchant_candidate_01';

    await expect(
      service.completeCallback({
        authorizationCode: 'server-side-authorization-code',
        cookieHeader: 'session=opaque',
        state: state as string,
      }),
    ).resolves.toEqual({ status: 'consent_required', transaction_ref: transactionRef });
    await expect(service.recordConsent(mutationContext, transactionRef, 'grant')).resolves.toEqual({
      status: 'connected',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(transactions.boundCandidate).toBe('merchant_candidate_01');
    expect(JSON.stringify(transactions.pending)).not.toContain(tokenPayload.open_id);
    expect(JSON.stringify(transactions.pending)).not.toContain(tokenPayload.access_token);
  });

  it('rejects a callback when the current login session differs from the bridge transaction', async () => {
    const { fetchMock, service } = createHarness();
    const started = await service.startAuthorization(mutationContext);
    if (started.status !== 'signed_in') throw new Error('Expected signed_in result');
    const state = new URL(started.authorization_url).searchParams.get('state');

    await expect(
      service.completeCallback({
        authorizationCode: 'server-side-authorization-code',
        cookieHeader: 'session=other',
        state: state as string,
      }),
    ).resolves.toEqual({ status: 'authorization_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects mutations without CSRF context before creating or changing authorization state', async () => {
    const { consent, service, states, transactions } = createHarness();

    await expect(
      service.startAuthorization({ ...mutationContext, csrfToken: undefined }),
    ).rejects.toBeInstanceOf(WorkBuddyMutationContextInvalidError);
    expect(states.created).toBeUndefined();
    expect(consent.recordDecisionCalls).toBe(0);
    expect(transactions.bindCalls).toBe(0);

    const controller = new WorkBuddyLocalAuthorizationController(service);
    await expect(
      controller.start('session=opaque', mutationContext.origin, undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const started = await service.startAuthorization(mutationContext);
    if (started.status !== 'signed_in') throw new Error('Expected signed_in result');
    const state = new URL(started.authorization_url).searchParams.get('state');
    await service.completeCallback({
      authorizationCode: 'server-side-authorization-code',
      cookieHeader: 'session=opaque',
      state: state as string,
    });
    const missingCsrf = { ...mutationContext, csrfToken: undefined };
    await expect(
      service.recordConsent(missingCsrf, transactionRef, 'grant'),
    ).rejects.toBeInstanceOf(WorkBuddyMutationContextInvalidError);
    await expect(
      service.selectMerchant(missingCsrf, transactionRef, 'merchant_candidate_01'),
    ).rejects.toBeInstanceOf(WorkBuddyMutationContextInvalidError);
    expect(consent.recordDecisionCalls).toBe(0);
    expect(transactions.bindCalls).toBe(0);
  });

  it('rejects wrong transaction refs and wrong login sessions without consent or binding', async () => {
    const { consent, service, transactions } = createHarness();
    const started = await service.startAuthorization(mutationContext);
    if (started.status !== 'signed_in') throw new Error('Expected signed_in result');
    const state = new URL(started.authorization_url).searchParams.get('state');
    await service.completeCallback({
      authorizationCode: 'server-side-authorization-code',
      cookieHeader: 'session=opaque',
      state: state as string,
    });

    await expect(
      service.recordConsent(mutationContext, otherTransactionRef, 'grant'),
    ).rejects.toBeInstanceOf(WorkBuddyAuthorizationTransactionInvalidError);
    await expect(
      service.recordConsent(
        { ...mutationContext, cookieHeader: 'session=other' },
        transactionRef,
        'grant',
      ),
    ).rejects.toBeInstanceOf(WorkBuddyAuthorizationTransactionInvalidError);
    expect(consent.recordDecisionCalls).toBe(0);
    expect(transactions.bindCalls).toBe(0);
  });

  it('scopes merchant selection and status to the exact transaction and complete session', async () => {
    const { candidates, consent, service, transactions } = createHarness();
    candidates.values = [
      { candidateRef: 'candidate_01', displayName: '商家一' },
      { candidateRef: 'candidate_02', displayName: '商家二' },
    ];
    const started = await service.startAuthorization(mutationContext);
    if (started.status !== 'signed_in') throw new Error('Expected signed_in result');
    const state = new URL(started.authorization_url).searchParams.get('state');
    await service.completeCallback({
      authorizationCode: 'server-side-authorization-code',
      cookieHeader: 'session=opaque',
      state: state as string,
    });

    await expect(
      service.selectMerchant(mutationContext, otherTransactionRef, 'candidate_02'),
    ).rejects.toBeInstanceOf(WorkBuddyAuthorizationTransactionInvalidError);
    expect(consent.recordDecisionCalls).toBe(0);
    expect(transactions.bindCalls).toBe(0);

    await service.readStatus('session=opaque', transactionRef);
    expect(transactions.statusSessionDigest).toEqual(new Uint8Array(32).fill(3));
  });

  it('returns trusted binding and merchant-selection states from platform services', async () => {
    const { candidates } = createHarness();
    const bridgeResult = {
      transactionId: transactionRef,
      merchantUserId,
      identity,
      grantedScopes: ['user.contact.readable'],
      accessTokenExpiresAt: new Date(now.getTime() + 3_600_000),
    };
    const completeAuthorization = vi.fn().mockResolvedValue(bridgeResult);
    const harness = createHarness();
    const withFakeBridge = new DefaultWorkBuddyLocalAuthorizationService({
      client: new WorkBuddyOpenApiClient(clientConfig, vi.fn()),
      bridge: { completeAuthorization },
      states: harness.states,
      login: harness.login,
      transactions: harness.transactions,
      candidates,
      consent: harness.consent,
      configurationId: 'workbuddy_config_01',
      configurationVersion: 1,
      clock: () => now,
    });
    await withFakeBridge.startAuthorization(mutationContext);

    candidates.values = [];
    await expect(
      withFakeBridge.completeCallback({
        authorizationCode: 'valid-code',
        cookieHeader: 'session=opaque',
        state: 'x'.repeat(32),
      }),
    ).resolves.toEqual({ status: 'binding_required', transaction_ref: transactionRef });

    candidates.values = [
      { candidateRef: 'candidate_01', displayName: '商家一' },
      { candidateRef: 'candidate_02', displayName: '商家二' },
    ];
    await expect(
      withFakeBridge.completeCallback({
        authorizationCode: 'valid-code',
        cookieHeader: 'session=opaque',
        state: 'y'.repeat(32),
      }),
    ).resolves.toEqual({
      status: 'merchant_selection_required',
      transaction_ref: transactionRef,
      candidates: [
        { candidate_ref: 'candidate_01', display_name: '商家一' },
        { candidate_ref: 'candidate_02', display_name: '商家二' },
      ],
    });
    await expect(
      withFakeBridge.selectMerchant(mutationContext, transactionRef, 'candidate_02'),
    ).resolves.toEqual({ status: 'consent_required', transaction_ref: transactionRef });
    await expect(
      withFakeBridge.recordConsent(mutationContext, transactionRef, 'grant'),
    ).resolves.toEqual({ status: 'connected' });
    expect(harness.transactions.boundCandidate).toBe('candidate_02');
    expect(completeAuthorization).toHaveBeenCalledTimes(2);
  });

  it('fails closed when runtime adapters are absent and validates callback input at the API edge', async () => {
    const runtimeService = createRuntimeWorkBuddyLocalAuthorization({});
    await expect(runtimeService.readStatus(undefined, undefined)).rejects.toThrow(
      WorkBuddyLocalAuthorizationUnavailableError,
    );

    const controller = new WorkBuddyLocalAuthorizationController(
      new UnavailableWorkBuddyLocalAuthorizationService(),
    );
    await expect(controller.status({}, undefined)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      controller.callback({ code: 'short', state: 'also-short' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.consent('session=opaque', mutationContext.origin, mutationContext.csrfToken, {
        decision: 'grant',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.selectMerchant(
        'session=opaque',
        mutationContext.origin,
        mutationContext.csrfToken,
        { candidate_ref: 'candidate_01' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
