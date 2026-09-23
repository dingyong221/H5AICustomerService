import { describe, expect, it, vi } from 'vitest';

import type { OnboardingApiClient, OnboardingEventPayload } from './onboarding-api-client';
import { initialOnboardingFormValues, type OnboardingFormValues } from './onboarding-form-model';
import { submitCompleteOnboarding } from './onboarding-submission';

const sessionId = '33333333333333333333333333333333';

const completeValues: OnboardingFormValues = {
  ...initialOnboardingFormValues,
  businessDescription: '提供上门清洗服务，服务家庭用户。',
  businessName: '示例清洗服务',
  industryCode: 'home_service',
  insufficientFactPolicy: 'say_unconfirmed',
  materialReference: '服务说明 V1',
  materialSummary: '包含服务范围和操作说明。',
  merchantConfirmed: true,
  offeringDescription: '上门清洗挂机空调。',
  offeringName: '挂机空调清洗',
  offeringTargetAudience: '家庭用户',
  pricingAvailability: 'none_confirmed',
  promotionAvailability: 'unknown',
};

const resultForEvent = (event: OnboardingEventPayload) => ({
  action: 'continue_onboarding' as const,
  missing_items: [],
  onboarding_session_id: sessionId,
  state:
    event.type === 'provide_industry'
      ? ('materials' as const)
      : event.type === 'provide_materials'
        ? ('policy' as const)
        : event.type === 'provide_policy'
          ? ('confirmation' as const)
          : ('generating' as const),
});

describe('complete onboarding submission', () => {
  it('returns the existing management entry without submitting any onboarding events', async () => {
    const advance = vi.fn<OnboardingApiClient['advance']>();
    const client: OnboardingApiClient = {
      advance,
      startOrResume: vi.fn(async () => ({
        action: 'open_management_console' as const,
        assistant: { assistant_ref: '44444444444444444444444444444444', status: 'active' },
        url: 'https://merchant.test/workspace',
      })),
    };

    await expect(
      submitCompleteOnboarding({
        client,
        createIdempotencyKey: () => 'reserved-key',
        values: completeValues,
      }),
    ).resolves.toMatchObject({ action: 'open_management_console' });
    expect(advance).not.toHaveBeenCalled();
  });

  it('replays every edited section before confirming a resumed confirmation session', async () => {
    const advance = vi.fn<OnboardingApiClient['advance']>(async ({ event }) =>
      resultForEvent(event),
    );
    const client: OnboardingApiClient = {
      advance,
      startOrResume: vi.fn(async () => ({
        action: 'continue_onboarding' as const,
        missing_items: [],
        onboarding_session_id: sessionId,
        state: 'confirmation' as const,
      })),
    };

    await expect(
      submitCompleteOnboarding({
        client,
        createIdempotencyKey: () => 'reserved-key',
        values: completeValues,
      }),
    ).resolves.toMatchObject({ state: 'generating' });

    expect(advance.mock.calls.map(([input]) => input.event.type)).toEqual([
      'provide_industry',
      'provide_materials',
      'provide_policy',
      'confirm',
    ]);
  });

  it('returns the management link after a confirmed generation completes', async () => {
    const startOrResume = vi
      .fn<OnboardingApiClient['startOrResume']>()
      .mockResolvedValueOnce({
        action: 'continue_onboarding',
        missing_items: [],
        onboarding_session_id: sessionId,
        state: 'industry',
      })
      .mockResolvedValueOnce({
        action: 'open_management_console',
        assistant: { assistant_ref: '44444444444444444444444444444444', status: 'draft_only' },
        url: 'https://merchant.test/workspace',
      });
    const client: OnboardingApiClient = {
      startOrResume,
      advance: vi.fn(async ({ event }) => ({
        ...resultForEvent(event),
        state: event.type === 'confirm' ? ('manageable' as const) : resultForEvent(event).state,
      })),
    };

    await expect(
      submitCompleteOnboarding({
        client,
        createIdempotencyKey: () => 'reserved-key',
        values: completeValues,
      }),
    ).resolves.toMatchObject({
      action: 'open_management_console',
      url: 'https://merchant.test/workspace',
    });
    expect(startOrResume).toHaveBeenCalledTimes(2);
  });
});
