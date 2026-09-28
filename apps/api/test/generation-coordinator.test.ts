import { describe, expect, it, vi } from 'vitest';

import type {
  AssistantLifecycleRepository,
  AssistantManagementSnapshot,
  OnboardingSessionRecord,
} from '@h5cs/domain';
import { toAssistantId, toMerchantId, toMerchantUserId, toOnboardingSessionId } from '@h5cs/domain';

import {
  ConfirmedFactsGenerationCoordinator,
  GenerationUnavailableError,
} from '../src/skill/generation-coordinator.js';

const merchantId = toMerchantId('22222222222222222222222222222222');
const assistantId = toAssistantId('44444444444444444444444444444444');
const session: OnboardingSessionRecord = {
  id: toOnboardingSessionId('33333333333333333333333333333333'),
  merchantUserId: toMerchantUserId('11111111111111111111111111111111'),
  merchantId,
  assistantId: null,
  snapshot: { state: 'generating', answers: { merchantConfirmed: true } },
  version: 4,
};

describe('confirmed-facts draft generation coordinator', () => {
  it('uses stable session-scoped idempotency for retries without transmitting credentials', async () => {
    const generateDraftFromOnboarding = vi.fn<
      AssistantLifecycleRepository['generateDraftFromOnboarding']
    >(async () => ({ assistantId }) as AssistantManagementSnapshot);
    const assertReady = vi.fn(async () => undefined);
    const coordinator = new ConfirmedFactsGenerationCoordinator({
      assertReady,
      generateDraftFromOnboarding,
    } as unknown as AssistantLifecycleRepository);

    await coordinator.assertReady();
    await expect(coordinator.generate(session, merchantId)).resolves.toBe(assistantId);
    await expect(coordinator.generate(session, merchantId)).resolves.toBe(assistantId);

    expect(assertReady).toHaveBeenCalledOnce();
    expect(generateDraftFromOnboarding).toHaveBeenCalledTimes(2);
    const first = generateDraftFromOnboarding.mock.calls[0]?.[0];
    const second = generateDraftFromOnboarding.mock.calls[1]?.[0];
    expect(first?.merchantUserId).toBe(session.merchantUserId);
    expect(first?.merchantId).toBe(merchantId);
    expect(first?.onboardingSessionId).toBe(session.id);
    expect(first?.idempotency.actorScopeDigest).toEqual(second?.idempotency.actorScopeDigest);
    expect(first?.idempotency.keyDigest).toEqual(second?.idempotency.keyDigest);
    expect(first?.idempotency.requestHash).toEqual(second?.idempotency.requestHash);
    expect(first?.idempotency.keyDigest).toHaveLength(32);
  });

  it('rejects an unconfirmed or different-merchant session before any database write', async () => {
    const generateDraftFromOnboarding = vi.fn();
    const coordinator = new ConfirmedFactsGenerationCoordinator({
      assertReady: async () => undefined,
      generateDraftFromOnboarding,
    } as unknown as AssistantLifecycleRepository);

    await expect(
      coordinator.generate(
        { ...session, snapshot: { state: 'confirmation', answers: {} } },
        merchantId,
      ),
    ).rejects.toBeInstanceOf(GenerationUnavailableError);
    await expect(
      coordinator.generate(
        { ...session, snapshot: { state: 'generating', answers: { merchantConfirmed: false } } },
        merchantId,
      ),
    ).rejects.toBeInstanceOf(GenerationUnavailableError);
    await expect(
      coordinator.generate(session, toMerchantId('99999999999999999999999999999999')),
    ).rejects.toBeInstanceOf(GenerationUnavailableError);
    expect(generateDraftFromOnboarding).not.toHaveBeenCalled();
  });
});
