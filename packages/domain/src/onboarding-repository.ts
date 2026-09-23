import type { AssistantId, MerchantId, MerchantUserId, OnboardingSessionId } from './ids.js';
import type { OnboardingSnapshot } from './onboarding.js';

export type VerifiedExternalIdentity = Readonly<{
  provider: 'workbuddy';
  issuer: string;
  audience: string;
  subjectLookupKey: Uint8Array;
  subjectLookupKeyVersion: number;
  phoneMatchVerifiedAt: Date | null;
  verifiedAt: Date;
}>;

export type AssistantManagementRecord = Readonly<{
  id: AssistantId;
  status: string;
}>;

export type MerchantUserRecord = Readonly<{
  id: MerchantUserId;
}>;

export type OnboardingSessionRecord = Readonly<{
  id: OnboardingSessionId;
  merchantUserId: MerchantUserId;
  merchantId: MerchantId | null;
  assistantId: AssistantId | null;
  snapshot: OnboardingSnapshot;
  version: number;
}>;

export class MerchantSelectionRequiredError extends Error {
  public constructor() {
    super('Multiple active merchant memberships require an explicit secure selection');
    this.name = 'MerchantSelectionRequiredError';
  }
}

export interface OnboardingRepository {
  assertReady(): Promise<void>;
  resolveOrCreateMerchantUser(identity: VerifiedExternalIdentity): Promise<MerchantUserRecord>;
  findMerchantBinding(merchantUserId: MerchantUserId): Promise<MerchantId | null>;
  listAssistants(
    merchantId: MerchantId,
    merchantUserId: MerchantUserId,
  ): Promise<readonly AssistantManagementRecord[]>;
  findLatestSession(merchantUserId: MerchantUserId): Promise<OnboardingSessionRecord | null>;
  findSession(
    merchantUserId: MerchantUserId,
    sessionId: OnboardingSessionId,
  ): Promise<OnboardingSessionRecord | null>;
  createSession(
    merchantUserId: MerchantUserId,
    merchantId: MerchantId,
    snapshot: OnboardingSnapshot,
  ): Promise<OnboardingSessionRecord>;
  saveSession(
    session: OnboardingSessionRecord,
    nextSnapshot: OnboardingSnapshot,
  ): Promise<OnboardingSessionRecord>;
  saveGenerationResult(
    session: OnboardingSessionRecord,
    nextSnapshot: OnboardingSnapshot,
    merchantId: MerchantId,
    assistantId: AssistantId,
  ): Promise<OnboardingSessionRecord>;
}
