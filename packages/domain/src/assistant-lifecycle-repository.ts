import type {
  AssistantId,
  MerchantId,
  MerchantUserId,
  OnboardingSessionId,
  ReleaseId,
} from './ids.js';

export type AssistantDraftConfig = Readonly<{
  industry: string;
  businessScope: string;
  materialsSummary: string;
  pricingSummary: string;
  promotionSummary: string;
  welcomeMessage: string;
  insufficientInfoMessage: string;
}>;

export type AssistantLifecycleIdempotency = Readonly<{
  actorScopeDigest: Uint8Array;
  keyDigest: Uint8Array;
  requestHash: Uint8Array;
  expiresAt: Date;
}>;

export type AssistantManagementSnapshot = Readonly<{
  assistantId: AssistantId;
  merchantId: MerchantId;
  displayName: string;
  publicSlug: string;
  status: 'draft_only' | 'active' | 'paused';
  draftRevision: number;
  draft: AssistantDraftConfig;
  knowledgeConfirmed: boolean;
  activeReleaseId: ReleaseId | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type AssistantReleaseRecord = Readonly<{
  releaseId: ReleaseId;
  merchantId: MerchantId;
  assistantId: AssistantId;
  releaseNo: number;
  status: 'active';
  draftRevision: number;
  createdAt: Date;
  activatedAt: Date;
}>;

export type PublicAssistantSnapshot = Readonly<{
  publicAssistantId: string;
  releaseRef: string;
  merchantName: string;
  assistantName: string;
  businessScope: string;
  welcomeMessage: string;
  insufficientInfoMessage: string;
  availability: 'online';
}>;

export class AssistantLifecyclePersistenceError extends Error {
  public constructor(message = 'Assistant lifecycle persistence is unavailable') {
    super(message);
    this.name = 'AssistantLifecyclePersistenceError';
  }
}

export class AssistantIdempotencyConflictError extends Error {
  public constructor() {
    super('Idempotency key was already used for another request');
    this.name = 'AssistantIdempotencyConflictError';
  }
}

export class AssistantGenerationUnavailableError extends Error {
  public constructor() {
    super('Onboarding session is not eligible for assistant generation');
    this.name = 'AssistantGenerationUnavailableError';
  }
}

export class AssistantRevisionConflictError extends Error {
  public constructor() {
    super('Assistant draft revision changed');
    this.name = 'AssistantRevisionConflictError';
  }
}

export class AssistantPublishValidationError extends Error {
  public constructor() {
    super('Assistant draft is not publishable');
    this.name = 'AssistantPublishValidationError';
  }
}

export interface AssistantLifecycleRepository {
  assertReady(): Promise<void>;
  generateDraftFromOnboarding(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    onboardingSessionId: OnboardingSessionId;
    idempotency: AssistantLifecycleIdempotency;
    now: Date;
  }): Promise<AssistantManagementSnapshot>;
  findManagementSnapshot(
    merchantId: MerchantId,
    assistantId: AssistantId,
  ): Promise<AssistantManagementSnapshot | null>;
  saveDraft(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    assistantId: AssistantId;
    expectedRevision: number;
    draft: AssistantDraftConfig;
    now: Date;
  }): Promise<AssistantManagementSnapshot>;
  publish(input: {
    merchantUserId: MerchantUserId;
    merchantId: MerchantId;
    assistantId: AssistantId;
    expectedDraftRevision: number;
    promptTemplateVersion: string;
    retrievalPolicyVersion: string;
    modelPolicyVersion: string;
    idempotency: AssistantLifecycleIdempotency;
    now: Date;
  }): Promise<AssistantReleaseRecord>;
  findPublicSnapshot(publicSlug: string): Promise<PublicAssistantSnapshot | null>;
}
