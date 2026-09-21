import type { MerchantId, MerchantUserId } from './ids.js';
import type { VerifiedExternalIdentity } from './onboarding-repository.js';

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
}
