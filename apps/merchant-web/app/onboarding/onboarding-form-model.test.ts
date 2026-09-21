import { describe, expect, it } from 'vitest';

import { OnboardingClientError } from './onboarding-api-client';
import {
  buildEventForStep,
  initialOnboardingFormValues,
  initialOnboardingInteractionState,
  reduceOnboardingInteraction,
  validateAllOnboardingSteps,
  validateOnboardingStep,
  type OnboardingFormValues,
} from './onboarding-form-model';

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

const serverResult = {
  action: 'continue_onboarding' as const,
  missing_items: [],
  onboarding_session_id: '33333333333333333333333333333333',
  state: 'materials' as const,
};

describe('onboarding form model', () => {
  it('validates every required stage without treating local input as saved', () => {
    expect(validateOnboardingStep('industry', initialOnboardingFormValues)).toHaveProperty(
      'industryCode',
    );
    expect(Object.keys(validateAllOnboardingSteps(completeValues))).toHaveLength(0);
  });

  it('requires price and promotion facts only when marked as provided', () => {
    const errors = validateOnboardingStep('policy', {
      ...completeValues,
      pricingAvailability: 'provided',
      promotionAvailability: 'provided',
    });
    expect(errors).toHaveProperty('priceAmount');
    expect(errors).toHaveProperty('promotionName');
    expect(errors).toHaveProperty('promotionDescription');
  });

  it('matches the shared contract price, currency and key length limits', () => {
    const errors = validateOnboardingStep('policy', {
      ...completeValues,
      priceAmount: '12.12345',
      priceCurrency: 'cny',
      pricingAvailability: 'provided',
    });
    expect(errors.priceAmount).toContain('小数最多 4 位');
    expect(errors.priceCurrency).toContain('3 位大写字母');

    const materialErrors = validateOnboardingStep('materials', {
      ...completeValues,
      businessName: 'a'.repeat(201),
      materialReference: 'r'.repeat(1_025),
    });
    expect(materialErrors).toHaveProperty('businessName');
    expect(materialErrors).toHaveProperty('materialReference');
  });

  it('builds contract-shaped material and policy events after validation', () => {
    expect(buildEventForStep('materials', completeValues)).toMatchObject({
      materials: [{ reference: '服务说明 V1' }],
      offerings: [{ name: '挂机空调清洗' }],
      type: 'provide_materials',
    });
    expect(buildEventForStep('policy', completeValues)).toMatchObject({
      pricingPolicy: { availability: 'none_confirmed', facts: [] },
      promotionPolicy: { availability: 'unknown', facts: [] },
      type: 'provide_policy',
    });
  });

  it('shows saved only after a server success action', () => {
    const editing = reduceOnboardingInteraction(initialOnboardingInteractionState, {
      type: 'edit',
    });
    const saving = reduceOnboardingInteraction(editing, {
      operation: 'save',
      type: 'request_started',
    });
    const saved = reduceOnboardingInteraction(saving, {
      result: serverResult,
      type: 'server_succeeded',
    });
    expect(editing.status).toBe('editing');
    expect(saving.status).toBe('saving');
    expect(saved.status).toBe('saved');
  });

  it('maps pause, generation, conflict and authentication expiry explicitly', () => {
    const paused = reduceOnboardingInteraction(initialOnboardingInteractionState, {
      result: { ...serverResult, state: 'cancelled' },
      type: 'server_succeeded',
    });
    const generating = reduceOnboardingInteraction(initialOnboardingInteractionState, {
      result: { ...serverResult, state: 'generating' },
      type: 'server_succeeded',
    });
    const conflict = reduceOnboardingInteraction(initialOnboardingInteractionState, {
      error: new OnboardingClientError('conflict', 'conflict'),
      type: 'request_failed',
    });
    const expired = reduceOnboardingInteraction(initialOnboardingInteractionState, {
      error: new OnboardingClientError('authentication_expired', 'expired'),
      type: 'request_failed',
    });
    expect(paused.status).toBe('paused');
    expect(generating.status).toBe('generating');
    expect(conflict.status).toBe('conflict');
    expect(expired.status).toBe('authentication_expired');
  });

  it('keeps binding, merchant selection and unavailable generation as separate states', () => {
    const kinds = [
      ['binding_required', 'binding_required'],
      ['merchant_selection_required', 'merchant_selection_required'],
      ['generation_unavailable', 'generation_unavailable'],
    ] as const;

    for (const [kind, expectedStatus] of kinds) {
      const state = reduceOnboardingInteraction(initialOnboardingInteractionState, {
        error: new OnboardingClientError(kind, kind),
        type: 'request_failed',
      });
      expect(state.status).toBe(expectedStatus);
    }
  });
});
