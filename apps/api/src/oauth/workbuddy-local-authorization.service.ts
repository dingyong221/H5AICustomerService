import { createHash, randomBytes } from 'node:crypto';

import type {
  MerchantUserId,
  VerifiedExternalIdentity,
  WorkBuddyBindingStateRepository,
} from '@h5cs/domain';

import {
  WorkBuddyAuthenticationRequiredError,
  WorkBuddyAuthenticationUnavailableError,
} from '../skill/workbuddy-authenticator.js';
import type {
  WorkBuddyIdentityBridge,
  WorkBuddyIdentityBridgeResult,
} from './workbuddy-identity-bridge.js';
import {
  WorkBuddyOpenApiExchangeError,
  type WorkBuddyOpenApiClient,
} from './workbuddy-open-api-client.js';

export type PlatformAccountSession = Readonly<{
  accountId: string;
  loginSessionDigest: Uint8Array;
  merchantUserId: MerchantUserId;
}>;

export type PlatformMutationContext = Readonly<{
  cookieHeader: string | undefined;
  csrfToken: string | undefined;
  origin: string | undefined;
}>;

export interface PlatformLoginService {
  assertReady(): Promise<void>;
  resolveSession(cookieHeader: string | undefined): Promise<PlatformAccountSession | null>;
  /** Must verify cookie, Origin and CSRF token before returning a mutation session. */
  resolveMutationSession(context: PlatformMutationContext): Promise<PlatformAccountSession | null>;
}

export type PlatformAuthorizationTransaction = Readonly<{
  accountId: string;
  loginSessionDigest: Uint8Array;
  merchantUserId: MerchantUserId;
  transactionRef: string;
}>;

export type PlatformPendingAuthorization = Readonly<{
  accountId: string;
  identity: VerifiedExternalIdentity;
  loginSessionDigest: Uint8Array;
  merchantUserId: MerchantUserId;
  selectedCandidateRef?: string | undefined;
  transactionRef: string;
}>;

export type MerchantCandidate = Readonly<{
  candidateRef: string;
  displayName: string;
}>;

export type StableWorkBuddyAuthorizationResult =
  | Readonly<{ status: 'consent_required'; transaction_ref: string }>
  | Readonly<{ status: 'binding_required'; transaction_ref: string }>
  | Readonly<{
      status: 'merchant_selection_required';
      transaction_ref: string;
      candidates: readonly Readonly<{ candidate_ref: string; display_name: string }>[];
    }>
  | Readonly<{ status: 'connected' | 'conflict' | 'revoked' | 'authorization_failed' }>;

export type WorkBuddyAuthorizationResult =
  | Readonly<{ status: 'sign_in_required' }>
  | Readonly<{ status: 'signed_in'; authorization_url: string; transaction_ref: string }>
  | StableWorkBuddyAuthorizationResult;

export interface PlatformAuthorizationTransactions {
  assertReady(): Promise<void>;
  begin(
    session: PlatformAccountSession,
    bridgeStateDigest: Uint8Array,
  ): Promise<PlatformAuthorizationTransaction>;
  /**
   * Must atomically verify transaction, merchant user and login-session digest before accepting.
   */
  acceptBridgeResult(
    result: WorkBuddyIdentityBridgeResult,
    session: PlatformAccountSession,
  ): Promise<
    | Readonly<{ status: 'accepted'; pending: PlatformPendingAuthorization }>
    | Readonly<{ status: 'conflict' | 'revoked' }>
  >;
  /** Must match the complete session and the exact opaque transaction reference. */
  findPending(
    session: PlatformAccountSession,
    transactionRef: string,
  ): Promise<PlatformPendingAuthorization | null>;
  selectMerchantCandidate(input: {
    candidateRef: string;
    session: PlatformAccountSession;
    transactionRef: string;
  }): Promise<PlatformPendingAuthorization>;
  bindMerchant(input: {
    candidateRef: string;
    session: PlatformAccountSession;
    transactionRef: string;
  }): Promise<Readonly<{ status: 'connected' | 'conflict' | 'revoked' }>>;
  readStatus(
    session: PlatformAccountSession,
    transactionRef: string | undefined,
  ): Promise<StableWorkBuddyAuthorizationResult>;
}

export interface PlatformMerchantCandidateService {
  assertReady(): Promise<void>;
  listCandidates(pending: PlatformPendingAuthorization): Promise<readonly MerchantCandidate[]>;
}

export type PlatformConsentDecision = 'required' | 'granted' | 'revoked';

export interface PlatformConsentService {
  assertReady(): Promise<void>;
  getDecision(
    pending: PlatformPendingAuthorization,
    candidateRef: string,
  ): Promise<PlatformConsentDecision>;
  recordDecision(
    pending: PlatformPendingAuthorization,
    candidateRef: string,
    decision: 'grant' | 'deny',
  ): Promise<void>;
}

export class WorkBuddyLocalAuthorizationUnavailableError extends Error {
  public constructor(message = 'Local-account WorkBuddy authorization is unavailable') {
    super(message);
    this.name = 'WorkBuddyLocalAuthorizationUnavailableError';
  }
}

export class WorkBuddyMerchantSelectionInvalidError extends Error {
  public constructor() {
    super('Merchant selection is invalid');
    this.name = 'WorkBuddyMerchantSelectionInvalidError';
  }
}

export class WorkBuddyAuthorizationTransactionInvalidError extends Error {
  public constructor() {
    super('Authorization transaction is invalid');
    this.name = 'WorkBuddyAuthorizationTransactionInvalidError';
  }
}

export class WorkBuddyMutationContextInvalidError extends Error {
  public constructor() {
    super('Mutation request verification failed');
    this.name = 'WorkBuddyMutationContextInvalidError';
  }
}

const validOpaqueIdentifier = (value: string): boolean =>
  /^[A-Za-z0-9](?:[A-Za-z0-9:_-]{0,190})$/u.test(value);
const validTransactionRef = (value: string): boolean => /^[0-9a-f]{64}$/u.test(value);
const validCsrfToken = (value: string | undefined): value is string =>
  value !== undefined && /^[A-Za-z0-9_-]{32,512}$/u.test(value);

const validMutationOrigin = (value: string | undefined): value is string => {
  if (value === undefined) return false;
  try {
    const origin = new URL(value);
    const loopback =
      origin.hostname === 'localhost' ||
      origin.hostname === '127.0.0.1' ||
      origin.hostname === '[::1]';
    return (
      (origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback)) &&
      origin.origin === value &&
      origin.username.length === 0 &&
      origin.password.length === 0
    );
  } catch {
    return false;
  }
};

const validateSession = (session: PlatformAccountSession): PlatformAccountSession => {
  if (!validOpaqueIdentifier(session.accountId)) {
    throw new WorkBuddyLocalAuthorizationUnavailableError(
      'Platform login adapter returned invalid data',
    );
  }
  if (session.loginSessionDigest.byteLength !== 32) {
    throw new WorkBuddyLocalAuthorizationUnavailableError(
      'Platform login adapter returned invalid session binding data',
    );
  }
  return session;
};

const validateTransaction = (
  transaction: PlatformAuthorizationTransaction,
  session: PlatformAccountSession,
): PlatformAuthorizationTransaction => {
  if (
    transaction.accountId !== session.accountId ||
    transaction.merchantUserId !== session.merchantUserId ||
    transaction.loginSessionDigest.byteLength !== 32 ||
    !Buffer.from(transaction.loginSessionDigest).equals(Buffer.from(session.loginSessionDigest)) ||
    !validTransactionRef(transaction.transactionRef)
  ) {
    throw new WorkBuddyLocalAuthorizationUnavailableError(
      'Platform authorization transaction adapter returned invalid data',
    );
  }
  return transaction;
};

const validateCandidates = (
  candidates: readonly MerchantCandidate[],
): readonly MerchantCandidate[] => {
  if (candidates.length > 100) {
    throw new WorkBuddyLocalAuthorizationUnavailableError(
      'Platform merchant candidate adapter returned too many candidates',
    );
  }
  const references = new Set<string>();
  for (const candidate of candidates) {
    const displayName = candidate.displayName.trim();
    if (
      !validOpaqueIdentifier(candidate.candidateRef) ||
      displayName.length === 0 ||
      displayName.length > 200 ||
      references.has(candidate.candidateRef)
    ) {
      throw new WorkBuddyLocalAuthorizationUnavailableError(
        'Platform merchant candidate adapter returned invalid data',
      );
    }
    references.add(candidate.candidateRef);
  }
  return candidates;
};

const validateConsentDecision = (decision: PlatformConsentDecision): PlatformConsentDecision => {
  if (decision !== 'required' && decision !== 'granted' && decision !== 'revoked') {
    throw new WorkBuddyLocalAuthorizationUnavailableError(
      'Platform consent adapter returned invalid data',
    );
  }
  return decision;
};

const validatePending = (
  pending: PlatformPendingAuthorization,
  client: WorkBuddyOpenApiClient,
): PlatformPendingAuthorization => {
  const identity = pending.identity;
  if (
    !validOpaqueIdentifier(pending.accountId) ||
    !validTransactionRef(pending.transactionRef) ||
    pending.loginSessionDigest.byteLength !== 32 ||
    (pending.selectedCandidateRef !== undefined &&
      !validOpaqueIdentifier(pending.selectedCandidateRef)) ||
    identity.provider !== 'workbuddy' ||
    identity.issuer !== client.issuer ||
    identity.audience !== client.clientId ||
    identity.subjectLookupKey.byteLength !== 32 ||
    !Number.isSafeInteger(identity.subjectLookupKeyVersion) ||
    identity.subjectLookupKeyVersion < 1 ||
    !Number.isFinite(identity.verifiedAt.getTime())
  ) {
    throw new WorkBuddyLocalAuthorizationUnavailableError(
      'Platform authorization transaction adapter returned invalid data',
    );
  }
  return pending;
};

const validatePendingForSession = (
  pending: PlatformPendingAuthorization,
  client: WorkBuddyOpenApiClient,
  session: PlatformAccountSession,
  transactionRef: string,
): PlatformPendingAuthorization => {
  const validated = validatePending(pending, client);
  if (
    validated.accountId !== session.accountId ||
    validated.merchantUserId !== session.merchantUserId ||
    validated.transactionRef !== transactionRef ||
    !Buffer.from(validated.loginSessionDigest).equals(Buffer.from(session.loginSessionDigest))
  ) {
    throw new WorkBuddyAuthorizationTransactionInvalidError();
  }
  return validated;
};

const validateBindingResult = (
  result: Readonly<{ status: 'connected' | 'conflict' | 'revoked' }>,
): Readonly<{ status: 'connected' | 'conflict' | 'revoked' }> => {
  if (
    result.status !== 'connected' &&
    result.status !== 'conflict' &&
    result.status !== 'revoked'
  ) {
    throw new WorkBuddyLocalAuthorizationUnavailableError(
      'Platform authorization transaction adapter returned invalid data',
    );
  }
  return result;
};

const validateStableResult = (
  result: StableWorkBuddyAuthorizationResult,
  expectedTransactionRef: string | undefined,
): StableWorkBuddyAuthorizationResult => {
  if (
    result.status === 'consent_required' ||
    result.status === 'binding_required' ||
    result.status === 'merchant_selection_required'
  ) {
    if (
      !validTransactionRef(result.transaction_ref) ||
      (expectedTransactionRef !== undefined && result.transaction_ref !== expectedTransactionRef)
    ) {
      throw new WorkBuddyAuthorizationTransactionInvalidError();
    }
  }
  return result;
};

export abstract class WorkBuddyLocalAuthorizationService {
  public abstract startAuthorization(
    context: PlatformMutationContext,
  ): Promise<WorkBuddyAuthorizationResult>;
  public abstract completeCallback(input: {
    authorizationCode: string;
    cookieHeader: string | undefined;
    state: string;
  }): Promise<WorkBuddyAuthorizationResult>;
  public abstract readStatus(
    cookieHeader: string | undefined,
    transactionRef: string | undefined,
  ): Promise<WorkBuddyAuthorizationResult>;
  public abstract recordConsent(
    context: PlatformMutationContext,
    transactionRef: string,
    decision: 'grant' | 'deny',
  ): Promise<WorkBuddyAuthorizationResult>;
  public abstract selectMerchant(
    context: PlatformMutationContext,
    transactionRef: string,
    candidateRef: string,
  ): Promise<WorkBuddyAuthorizationResult>;
}

export class UnavailableWorkBuddyLocalAuthorizationService extends WorkBuddyLocalAuthorizationService {
  readonly #reason: string;

  public constructor(reason = 'Platform login or authorization persistence is not configured') {
    super();
    this.#reason = reason;
  }

  public async startAuthorization(): Promise<never> {
    return this.#fail();
  }

  public async completeCallback(): Promise<never> {
    return this.#fail();
  }

  public async readStatus(): Promise<never> {
    return this.#fail();
  }

  public async recordConsent(): Promise<never> {
    return this.#fail();
  }

  public async selectMerchant(): Promise<never> {
    return this.#fail();
  }

  async #fail(): Promise<never> {
    await Promise.resolve();
    throw new WorkBuddyLocalAuthorizationUnavailableError(this.#reason);
  }
}

export class DefaultWorkBuddyLocalAuthorizationService extends WorkBuddyLocalAuthorizationService {
  readonly #client: WorkBuddyOpenApiClient;
  readonly #bridge: Pick<WorkBuddyIdentityBridge, 'completeAuthorization'>;
  readonly #states: WorkBuddyBindingStateRepository;
  readonly #login: PlatformLoginService;
  readonly #transactions: PlatformAuthorizationTransactions;
  readonly #candidates: PlatformMerchantCandidateService;
  readonly #consent: PlatformConsentService;
  readonly #clock: () => Date;
  readonly #configurationId: string;
  readonly #configurationVersion: number;

  public constructor(input: {
    client: WorkBuddyOpenApiClient;
    bridge: Pick<WorkBuddyIdentityBridge, 'completeAuthorization'>;
    states: WorkBuddyBindingStateRepository;
    login: PlatformLoginService;
    transactions: PlatformAuthorizationTransactions;
    candidates: PlatformMerchantCandidateService;
    consent: PlatformConsentService;
    configurationId: string;
    configurationVersion: number;
    clock?: () => Date;
  }) {
    super();
    this.#client = input.client;
    this.#bridge = input.bridge;
    this.#states = input.states;
    this.#login = input.login;
    this.#transactions = input.transactions;
    this.#candidates = input.candidates;
    this.#consent = input.consent;
    if (
      !validOpaqueIdentifier(input.configurationId) ||
      !Number.isSafeInteger(input.configurationVersion) ||
      input.configurationVersion < 1
    ) {
      throw new WorkBuddyLocalAuthorizationUnavailableError(
        'WorkBuddy authorization configuration identity is invalid',
      );
    }
    this.#configurationId = input.configurationId;
    this.#configurationVersion = input.configurationVersion;
    this.#clock = input.clock ?? (() => new Date());
  }

  public async startAuthorization(
    context: PlatformMutationContext,
  ): Promise<WorkBuddyAuthorizationResult> {
    await this.#assertReady();
    const session = await this.#resolveMutationSession(context);
    if (session === null) return { status: 'sign_in_required' };

    const state = randomBytes(32).toString('base64url');
    const stateDigest = createHash('sha256').update(state, 'ascii').digest();
    const transaction = validateTransaction(
      await this.#transactions.begin(session, stateDigest),
      session,
    );
    const createdAt = this.#clock();
    await this.#states.store({
      stateDigest,
      transactionId: transaction.transactionRef,
      merchantUserId: transaction.merchantUserId,
      loginSessionDigest: session.loginSessionDigest,
      configurationId: this.#configurationId,
      configurationVersion: this.#configurationVersion,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 5 * 60 * 1_000),
    });
    return {
      status: 'signed_in',
      authorization_url: this.#client.buildAuthorizationUrl(state),
      transaction_ref: transaction.transactionRef,
    };
  }

  public async completeCallback(input: {
    authorizationCode: string;
    cookieHeader: string | undefined;
    state: string;
  }): Promise<WorkBuddyAuthorizationResult> {
    await this.#assertReady();
    const session = await this.#resolveSession(input.cookieHeader);
    if (session === null) return { status: 'sign_in_required' };
    let result: WorkBuddyIdentityBridgeResult;
    try {
      result = await this.#bridge.completeAuthorization({
        authorizationCode: input.authorizationCode,
        loginSessionDigest: session.loginSessionDigest,
        state: input.state,
      });
    } catch (error) {
      if (
        error instanceof WorkBuddyAuthenticationRequiredError ||
        error instanceof WorkBuddyOpenApiExchangeError
      ) {
        return { status: 'authorization_failed' };
      }
      if (error instanceof WorkBuddyAuthenticationUnavailableError) {
        throw new WorkBuddyLocalAuthorizationUnavailableError();
      }
      throw error;
    }

    if (result.merchantUserId !== session.merchantUserId) {
      return { status: 'authorization_failed' };
    }
    const accepted = await this.#transactions.acceptBridgeResult(result, session);
    if (accepted.status === 'conflict' || accepted.status === 'revoked') return accepted;
    if (accepted.status !== 'accepted') {
      throw new WorkBuddyLocalAuthorizationUnavailableError(
        'Platform authorization transaction adapter returned invalid data',
      );
    }
    const pending = validatePendingForSession(
      accepted.pending,
      this.#client,
      session,
      result.transactionId,
    );
    return this.#finishPending(pending, session);
  }

  public async readStatus(
    cookieHeader: string | undefined,
    transactionRef: string | undefined,
  ): Promise<WorkBuddyAuthorizationResult> {
    await this.#assertReady();
    const session = await this.#resolveSession(cookieHeader);
    if (session === null) return { status: 'sign_in_required' };
    if (transactionRef !== undefined && !validTransactionRef(transactionRef)) {
      throw new WorkBuddyAuthorizationTransactionInvalidError();
    }
    return validateStableResult(
      await this.#transactions.readStatus(session, transactionRef),
      transactionRef,
    );
  }

  public async recordConsent(
    context: PlatformMutationContext,
    transactionRef: string,
    decision: 'grant' | 'deny',
  ): Promise<WorkBuddyAuthorizationResult> {
    await this.#assertReady();
    if (!validTransactionRef(transactionRef)) {
      throw new WorkBuddyAuthorizationTransactionInvalidError();
    }
    const session = await this.#resolveMutationSession(context);
    if (session === null) return { status: 'sign_in_required' };
    const pending = await this.#transactions.findPending(session, transactionRef);
    if (pending === null) throw new WorkBuddyAuthorizationTransactionInvalidError();
    const validatedPending = validatePendingForSession(
      pending,
      this.#client,
      session,
      transactionRef,
    );
    const candidate = await this.#resolveCandidateForConsent(validatedPending);
    if (candidate === null) return this.#merchantSelectionResult(validatedPending);
    await this.#consent.recordDecision(validatedPending, candidate.candidateRef, decision);
    if (decision === 'deny') return { status: 'revoked' };
    return this.#bindCandidate(validatedPending, session, candidate.candidateRef);
  }

  public async selectMerchant(
    context: PlatformMutationContext,
    transactionRef: string,
    candidateRef: string,
  ): Promise<WorkBuddyAuthorizationResult> {
    await this.#assertReady();
    if (!validTransactionRef(transactionRef)) {
      throw new WorkBuddyAuthorizationTransactionInvalidError();
    }
    const session = await this.#resolveMutationSession(context);
    if (session === null) return { status: 'sign_in_required' };
    if (!validOpaqueIdentifier(candidateRef)) throw new WorkBuddyMerchantSelectionInvalidError();
    const pending = await this.#transactions.findPending(session, transactionRef);
    if (pending === null) throw new WorkBuddyAuthorizationTransactionInvalidError();
    const validatedPending = validatePendingForSession(
      pending,
      this.#client,
      session,
      transactionRef,
    );
    const candidates = validateCandidates(await this.#candidates.listCandidates(validatedPending));
    if (!candidates.some((candidate) => candidate.candidateRef === candidateRef)) {
      throw new WorkBuddyMerchantSelectionInvalidError();
    }
    const selected = validatePending(
      await this.#transactions.selectMerchantCandidate({
        candidateRef,
        session,
        transactionRef,
      }),
      this.#client,
    );
    if (selected.selectedCandidateRef !== candidateRef) {
      throw new WorkBuddyLocalAuthorizationUnavailableError(
        'Platform authorization transaction adapter did not retain merchant selection',
      );
    }
    const selectedForSession = validatePendingForSession(
      selected,
      this.#client,
      session,
      transactionRef,
    );
    return this.#finishPending(selectedForSession, session);
  }

  async #assertReady(): Promise<void> {
    try {
      await Promise.all([
        this.#states.assertReady(),
        this.#login.assertReady(),
        this.#transactions.assertReady(),
        this.#candidates.assertReady(),
        this.#consent.assertReady(),
      ]);
    } catch (error) {
      if (error instanceof WorkBuddyLocalAuthorizationUnavailableError) throw error;
      throw new WorkBuddyLocalAuthorizationUnavailableError();
    }
  }

  async #resolveSession(cookieHeader: string | undefined): Promise<PlatformAccountSession | null> {
    const session = await this.#login.resolveSession(cookieHeader);
    return session === null ? null : validateSession(session);
  }

  async #resolveMutationSession(
    context: PlatformMutationContext,
  ): Promise<PlatformAccountSession | null> {
    if (!validCsrfToken(context.csrfToken) || !validMutationOrigin(context.origin)) {
      throw new WorkBuddyMutationContextInvalidError();
    }
    const session = await this.#login.resolveMutationSession(context);
    return session === null ? null : validateSession(session);
  }

  async #finishPending(
    pending: PlatformPendingAuthorization,
    session: PlatformAccountSession,
  ): Promise<StableWorkBuddyAuthorizationResult> {
    const candidate = await this.#resolveCandidateForConsent(pending);
    if (candidate === null) return this.#merchantSelectionResult(pending);
    const consent = validateConsentDecision(
      await this.#consent.getDecision(pending, candidate.candidateRef),
    );
    if (consent === 'required') {
      return { status: 'consent_required', transaction_ref: pending.transactionRef };
    }
    if (consent === 'revoked') return { status: 'revoked' };
    return this.#bindCandidate(pending, session, candidate.candidateRef);
  }

  async #resolveCandidateForConsent(
    pending: PlatformPendingAuthorization,
  ): Promise<MerchantCandidate | null> {
    const candidates = validateCandidates(await this.#candidates.listCandidates(pending));
    if (pending.selectedCandidateRef !== undefined) {
      const selected = candidates.find(
        (candidate) => candidate.candidateRef === pending.selectedCandidateRef,
      );
      if (selected === undefined) {
        throw new WorkBuddyLocalAuthorizationUnavailableError(
          'Platform authorization transaction retained an invalid merchant selection',
        );
      }
      return selected;
    }
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }

  async #merchantSelectionResult(
    pending: PlatformPendingAuthorization,
  ): Promise<StableWorkBuddyAuthorizationResult> {
    const candidates = validateCandidates(await this.#candidates.listCandidates(pending));
    if (candidates.length === 0) {
      return { status: 'binding_required', transaction_ref: pending.transactionRef };
    }
    return {
      status: 'merchant_selection_required',
      transaction_ref: pending.transactionRef,
      candidates: candidates.map((candidate) => ({
        candidate_ref: candidate.candidateRef,
        display_name: candidate.displayName.trim(),
      })),
    };
  }

  async #bindCandidate(
    pending: PlatformPendingAuthorization,
    session: PlatformAccountSession,
    candidateRef: string,
  ): Promise<Readonly<{ status: 'connected' | 'conflict' | 'revoked' }>> {
    return validateBindingResult(
      await this.#transactions.bindMerchant({
        candidateRef,
        session,
        transactionRef: pending.transactionRef,
      }),
    );
  }
}
