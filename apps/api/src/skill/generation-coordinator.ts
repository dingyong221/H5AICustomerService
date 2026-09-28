import { createHash } from 'node:crypto';

import type {
  AssistantId,
  AssistantLifecycleRepository,
  MerchantId,
  OnboardingSessionRecord,
} from '@h5cs/domain';

export interface GenerationCoordinator {
  assertReady(): Promise<void>;
  generate(session: OnboardingSessionRecord, merchantId: MerchantId): Promise<AssistantId>;
}

export class GenerationUnavailableError extends Error {
  public constructor(reason = 'Assistant generation is not configured') {
    super(reason);
    this.name = 'GenerationUnavailableError';
  }
}

export class UnavailableGenerationCoordinator implements GenerationCoordinator {
  readonly #reason: string;

  public constructor(reason = 'Assistant generation is not configured') {
    this.#reason = reason;
  }

  public async assertReady(): Promise<never> {
    await Promise.resolve();
    throw new GenerationUnavailableError(this.#reason);
  }

  public async generate(): Promise<never> {
    return this.assertReady();
  }
}

const digest = (value: string): Uint8Array => createHash('sha256').update(value, 'utf8').digest();

export class ConfirmedFactsGenerationCoordinator implements GenerationCoordinator {
  public constructor(private readonly repository: AssistantLifecycleRepository) {}

  public async assertReady(): Promise<void> {
    await this.repository.assertReady();
  }

  public async generate(
    session: OnboardingSessionRecord,
    merchantId: MerchantId,
  ): Promise<AssistantId> {
    if (
      session.merchantId !== merchantId ||
      session.snapshot.state !== 'generating' ||
      session.snapshot.answers.merchantConfirmed !== true
    ) {
      throw new GenerationUnavailableError('Confirmed onboarding ownership is not available');
    }
    const now = new Date();
    const created = await this.repository.generateDraftFromOnboarding({
      merchantUserId: session.merchantUserId,
      merchantId,
      onboardingSessionId: session.id,
      idempotency: {
        actorScopeDigest: digest(`workbuddy:${session.merchantUserId}:${merchantId}`),
        keyDigest: digest(`onboarding:${session.id}`),
        requestHash: digest(`onboarding:${session.id}:${session.merchantUserId}:${merchantId}`),
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
      },
      now,
    });
    return created.assistantId;
  }
}
