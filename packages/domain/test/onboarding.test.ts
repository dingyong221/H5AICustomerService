import { describe, expect, it } from 'vitest';

import {
  InvalidOnboardingTransitionError,
  createOnboardingSnapshot,
  getOnboardingMissingItems,
  toAssistantId,
  transitionOnboarding,
} from '../src/index.js';

describe('onboarding state machine', () => {
  it('makes missing requirements explicit and reaches manageable only after generation', () => {
    let snapshot = createOnboardingSnapshot();
    expect(getOnboardingMissingItems(snapshot).map((item) => item.code)).toContain('industry_code');

    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_industry',
      industryCode: 'home_service',
    });
    expect(snapshot.state).toBe('materials');

    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_materials',
      businessName: '安心服务',
      businessDescription: '提供家电清洗服务',
      offerings: [
        {
          kind: 'service',
          name: '空调清洗',
          description: '挂机空调清洗服务',
          targetAudience: '本地家庭用户',
        },
      ],
      materials: [
        {
          kind: 'faq',
          reference: 'faq:cleaning-v1',
          summary: '包含服务范围及起步价格条件',
        },
      ],
    });
    expect(snapshot.state).toBe('policy');

    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_policy',
      pricingPolicy: {
        availability: 'provided',
        facts: [
          {
            offeringName: '空调清洗',
            amount: '100.00',
            currency: 'CNY',
            conditions: '单台挂机起步价，特殊机型另行确认',
          },
        ],
      },
      promotionPolicy: { availability: 'unknown', facts: [] },
      insufficientFactPolicy: 'say_unconfirmed',
    });
    expect(snapshot.state).toBe('confirmation');
    expect(getOnboardingMissingItems(snapshot).map((item) => item.code)).toEqual([
      'merchant_confirmation',
    ]);

    snapshot = transitionOnboarding(snapshot, { type: 'confirm' });
    expect(snapshot.state).toBe('generating');
    snapshot = transitionOnboarding(snapshot, {
      type: 'generation_succeeded',
      assistantId: toAssistantId('assistant-1'),
    });
    expect(snapshot.state).toBe('manageable');
    expect(snapshot.generatedAssistantId).toBe('assistant-1');
  });

  it('supports cancellation and resumes at the prior safe state', () => {
    const materials = transitionOnboarding(createOnboardingSnapshot(), {
      type: 'provide_industry',
      industryCode: 'retail',
    });
    const cancelled = transitionOnboarding(materials, { type: 'cancel' });
    const resumed = transitionOnboarding(cancelled, { type: 'resume' });

    expect(cancelled.state).toBe('cancelled');
    expect(resumed.state).toBe('materials');
    expect(resumed.answers.industryCode).toBe('retail');
  });

  it('does not allow callers to skip required stages', () => {
    expect(() => transitionOnboarding(createOnboardingSnapshot(), { type: 'confirm' })).toThrow(
      InvalidOnboardingTransitionError,
    );
  });

  it('allows safe edits before confirmation and re-evaluates every required stage', () => {
    let snapshot = transitionOnboarding(createOnboardingSnapshot(), {
      type: 'provide_industry',
      industryCode: 'home_service',
    });
    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_materials',
      businessName: '安心服务',
      businessDescription: '提供家电清洗服务',
      offerings: [
        {
          kind: 'service',
          name: '空调清洗',
          description: '挂机空调清洗服务',
          targetAudience: '本地家庭用户',
        },
      ],
      materials: [{ kind: 'faq', reference: 'faq:v1', summary: '服务范围' }],
    });
    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_policy',
      pricingPolicy: { availability: 'none_confirmed', facts: [] },
      promotionPolicy: { availability: 'unknown', facts: [] },
      insufficientFactPolicy: 'say_unconfirmed',
    });
    expect(snapshot.state).toBe('confirmation');

    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_industry',
      industryCode: 'retail',
    });
    expect(snapshot.state).toBe('materials');
    expect(snapshot.answers.merchantConfirmed).toBe(false);

    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_materials',
      businessName: '',
    });
    expect(snapshot.state).toBe('materials');
    expect(getOnboardingMissingItems(snapshot).map((item) => item.code)).toContain('business_name');

    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_materials',
      businessName: '安心零售',
    });
    expect(snapshot.state).toBe('policy');

    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_policy',
      pricingPolicy: { availability: 'provided', facts: [] },
    });
    expect(snapshot.state).toBe('policy');
    expect(getOnboardingMissingItems(snapshot).map((item) => item.code)).toContain(
      'pricing_policy',
    );
    expect(() => transitionOnboarding(snapshot, { type: 'confirm' })).toThrow(
      InvalidOnboardingTransitionError,
    );

    snapshot = transitionOnboarding(snapshot, {
      type: 'provide_policy',
      pricingPolicy: { availability: 'none_confirmed', facts: [] },
    });
    expect(snapshot.state).toBe('confirmation');
  });

  it('rejects edits after generation starts or the flow becomes terminal', () => {
    const edit = { type: 'provide_industry' as const, industryCode: 'retail' };
    const generating = {
      state: 'generating' as const,
      answers: { industryCode: 'retail', merchantConfirmed: true },
    };
    const manageable = { ...generating, state: 'manageable' as const };
    const cancelled = { ...generating, state: 'cancelled' as const };

    expect(() => transitionOnboarding(generating, edit)).toThrow(InvalidOnboardingTransitionError);
    expect(() => transitionOnboarding(manageable, edit)).toThrow(InvalidOnboardingTransitionError);
    expect(() => transitionOnboarding(cancelled, edit)).toThrow(InvalidOnboardingTransitionError);
  });

  it('does not let an edit move a malformed snapshot past an earlier missing requirement', () => {
    const malformedPolicySnapshot = {
      state: 'policy' as const,
      answers: {
        businessName: '安心服务',
        businessDescription: '提供家电清洗服务',
        offerings: [
          {
            kind: 'service' as const,
            name: '空调清洗',
            description: '挂机空调清洗服务',
            targetAudience: '本地家庭用户',
          },
        ],
        materials: [{ kind: 'faq' as const, reference: 'faq:v1', summary: '服务范围' }],
      },
    };

    const afterPolicyEdit = transitionOnboarding(malformedPolicySnapshot, {
      type: 'provide_policy',
      pricingPolicy: { availability: 'none_confirmed', facts: [] },
      promotionPolicy: { availability: 'unknown', facts: [] },
      insufficientFactPolicy: 'say_unconfirmed',
    });

    expect(afterPolicyEdit.state).toBe('policy');
    expect(getOnboardingMissingItems(afterPolicyEdit).map((item) => item.code)).toContain(
      'industry_code',
    );
  });
});
