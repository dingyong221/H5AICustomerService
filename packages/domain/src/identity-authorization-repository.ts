import type { ExternalIdentityId, MerchantId, MerchantUserId } from './ids.js';
import type { VerifiedExternalIdentity } from './onboarding-repository.js';
import type { OAuthAuthorizationCodeRecord } from './oauth-repository.js';

export type WorkBuddyBindingStateRecord = Readonly<{
  transactionId: string;
  merchantUserId: MerchantUserId;
  loginSessionDigest: Uint8Array;
  configurationId: string;
  configurationVersion: number;
  expiresAt: Date;
}>;

export type WorkBuddyBindingStateToStore = WorkBuddyBindingStateRecord &
  Readonly<{
    stateDigest: Uint8Array;
    createdAt: Date;
  }>;

export interface WorkBuddyBindingStateRepository {
  assertReady(): Promise<void>;
  store(record: WorkBuddyBindingStateToStore): Promise<void>;
  consume(
    stateDigest: Uint8Array,
    loginSessionDigest: Uint8Array,
    now: Date,
  ): Promise<WorkBuddyBindingStateRecord | null>;
}

export type ExternalIdentityBindingResult = Readonly<{
  status: 'created' | 'idempotent';
  externalIdentityId: ExternalIdentityId;
}>;

export class ExternalIdentityBindingConflictError extends Error {
  public constructor() {
    super('External identity binding conflicts with a retained account binding');
    this.name = 'ExternalIdentityBindingConflictError';
  }
}

export class ConnectorAuthorizationConflictError extends Error {
  public constructor() {
    super('Connector authorization transaction is unavailable or no longer valid');
    this.name = 'ConnectorAuthorizationConflictError';
  }
}

export interface ExternalIdentityBindingRepository {
  bind(
    merchantUserId: MerchantUserId,
    identity: VerifiedExternalIdentity,
  ): Promise<ExternalIdentityBindingResult>;
}

export const connectorAuthorizationSteps = [
  'requested',
  'login_required',
  'binding_required',
  'merchant_selection_required',
  'consent_required',
  'approved',
  'code_issued',
  'consumed',
  'denied',
  'expired',
  'failed',
] as const;

export type ConnectorAuthorizationStep = (typeof connectorAuthorizationSteps)[number];

export type ConnectorAuthorizationTransaction = Readonly<{
  transactionDigest: Uint8Array;
  loginSessionDigest: Uint8Array;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: 'mcp:tools';
  codeChallenge: string;
  /**
   * This digest only validates an externally carried Connector state. It cannot reconstruct the
   * original value; code issuance must remain blocked unless an authenticated/encrypted browser
   * context supplies the exact original state and matches this digest.
   */
  connectorStateDigest: Uint8Array;
  step: ConnectorAuthorizationStep;
  merchantUserId: MerchantUserId | null;
  externalIdentityId: ExternalIdentityId | null;
  merchantId: MerchantId | null;
  candidateVersion: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ConnectorConsentGrant = Readonly<{
  grantId: string;
  bindingId: string;
  authorizationTransactionDigest: Uint8Array;
  merchantUserId: MerchantUserId;
  externalIdentityId: ExternalIdentityId;
  merchantId: MerchantId;
  clientId: string;
  resource: string;
  scope: 'mcp:tools';
  consentVersion: string;
  status: 'active' | 'revoked' | 'expired';
  grantedAt: Date;
  revokedAt: Date | null;
}>;

export interface ConnectorAuthorizationRepository {
  storeAuthorizationTransaction(record: ConnectorAuthorizationTransaction): Promise<void>;
  acceptExternalIdentity(input: {
    transactionDigest: Uint8Array;
    loginSessionDigest: Uint8Array;
    merchantUserId: MerchantUserId;
    identity: VerifiedExternalIdentity;
    now: Date;
  }): Promise<
    Readonly<{
      transaction: ConnectorAuthorizationTransaction;
      binding: ExternalIdentityBindingResult;
    }>
  >;
  listActiveMerchantCandidates(
    transactionDigest: Uint8Array,
    loginSessionDigest: Uint8Array,
    now: Date,
  ): Promise<AuthorizationMerchantCandidateSet | null>;
  selectMerchantForAuthorization(input: {
    transactionDigest: Uint8Array;
    loginSessionDigest: Uint8Array;
    merchantId: MerchantId;
    expectedCandidateVersion: number;
    now: Date;
  }): Promise<ConnectorAuthorizationTransaction | null>;
  consumeAuthorizationTransaction(
    transactionDigest: Uint8Array,
    loginSessionDigest: Uint8Array,
    now: Date,
  ): Promise<ConnectorAuthorizationTransaction | null>;
  /** Activates one merchant grant and atomically revokes the prior active grant for this context. */
  activateConsentGrant(
    grant: ConnectorConsentGrant,
    now: Date,
  ): Promise<Readonly<{ replacedGrantIds: readonly string[] }>>;
  /**
   * Rechecks the session, identity and membership, replaces the active grant and creates exactly
   * one authorization code in the same database transaction.
   */
  approveConsentAndIssueAuthorizationCode(
    grant: ConnectorConsentGrant,
    code: OAuthAuthorizationCodeRecord,
    now: Date,
  ): Promise<Readonly<{ replacedGrantIds: readonly string[] }>>;
  resolveActiveBinding(bindingId: string, now: Date): Promise<ConnectorBindingResolution | null>;
  revokeConsentGrant(bindingId: string, now: Date): Promise<boolean>;
}

export type AuthorizationMerchantCandidateSet = Readonly<{
  candidateVersion: number;
  candidates: readonly Readonly<{ merchantId: MerchantId; displayName: string }>[];
}>;

export type ConnectorBindingResolution = Readonly<{
  grantId: string;
  bindingId: string;
  merchantUserId: MerchantUserId;
  externalIdentityId: ExternalIdentityId;
  merchantId: MerchantId;
  clientId: string;
  resource: string;
  scope: 'mcp:tools';
  identity: VerifiedExternalIdentity;
}>;

export const platformAuthenticationLevels = ['primary', 'reauthenticated'] as const;

export type PlatformAuthenticationLevel = (typeof platformAuthenticationLevels)[number];

export type PlatformLoginSessionRecord = Readonly<{
  sessionDigest: Uint8Array;
  merchantUserId: MerchantUserId;
  csrfDigest: Uint8Array;
  authenticationLevel: PlatformAuthenticationLevel;
  authenticatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface PlatformLoginSessionRepository {
  assertReady(): Promise<void>;
  storePlatformLoginSession(record: PlatformLoginSessionRecord): Promise<void>;
  resolvePlatformLoginSession(
    sessionDigest: Uint8Array,
    now: Date,
  ): Promise<PlatformLoginSessionRecord | null>;
  resolvePlatformMutationSession(
    sessionDigest: Uint8Array,
    csrfDigest: Uint8Array,
    now: Date,
  ): Promise<PlatformLoginSessionRecord | null>;
  revokePlatformLoginSession(sessionDigest: Uint8Array, now: Date): Promise<boolean>;
}
