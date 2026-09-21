import { describe, expect, it } from 'vitest';

import {
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  livenessDataSchema,
  onboardingEventRequestSchema,
  skillIntentRequestSchema,
  skillIntentResultSchema,
  tenantContextSchema,
} from '../src/index.js';

describe('shared contracts', () => {
  it('parses a tenant context with explicit actor and scopes', () => {
    const parsed = tenantContextSchema.parse({
      merchant_id: 'merchant-1',
      assistant_id: 'assistant-1',
      actor_id: 'account-1',
      actor_type: 'merchant_user',
      scopes: ['assistant:read'],
    });

    expect(parsed.merchant_id).toBe('merchant-1');
  });

  it('validates success and error envelopes', () => {
    const live = livenessDataSchema.parse({
      status: 'ok',
      service: 'api',
      timestamp: new Date().toISOString(),
    });

    expect(
      apiSuccessEnvelopeSchema(livenessDataSchema).parse({ data: live, request_id: 'request-123' }),
    ).toBeDefined();
    expect(
      apiErrorEnvelopeSchema.parse({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'not ready',
          retryable: true,
        },
        request_id: 'request-123',
      }),
    ).toBeDefined();
  });

  it('accepts the supported Skill intents and rejects caller-supplied external identity', () => {
    expect(skillIntentRequestSchema.parse({ intent: 'create_customer_service' }).intent).toBe(
      'create_customer_service',
    );
    expect(skillIntentRequestSchema.parse({ intent: 'open_management_console' }).intent).toBe(
      'open_management_console',
    );
    expect(skillIntentRequestSchema.parse({ intent: 'help' }).intent).toBe('help');
    expect(() =>
      skillIntentRequestSchema.parse({
        intent: 'create_customer_service',
        open_id: 'caller-controlled-subject',
      }),
    ).toThrow();
  });

  it('validates an explicit onboarding continuation result', () => {
    expect(
      skillIntentResultSchema.parse({
        action: 'continue_onboarding',
        onboarding_session_id: '33333333333333333333333333333333',
        state: 'industry',
        missing_items: [{ code: 'industry_code', message: '请选择行业' }],
      }).action,
    ).toBe('continue_onboarding');
  });

  it('rejects malformed external onboarding session IDs', () => {
    expect(() =>
      skillIntentRequestSchema.parse({
        intent: 'create_customer_service',
        resume_session_id: 'not-a-binary-id',
      }),
    ).toThrow();
  });

  it('accepts structured merchant onboarding events and rejects internal generation events', () => {
    expect(
      onboardingEventRequestSchema.parse({
        event: {
          type: 'provide_policy',
          pricingPolicy: {
            availability: 'provided',
            facts: [{ offeringName: '空调清洗', amount: '100.00', currency: 'CNY' }],
          },
          promotionPolicy: { availability: 'unknown', facts: [] },
          insufficientFactPolicy: 'say_unconfirmed',
        },
      }).event.type,
    ).toBe('provide_policy');

    expect(() =>
      onboardingEventRequestSchema.parse({
        event: { type: 'generation_succeeded', assistantId: 'caller-controlled' },
      }),
    ).toThrow();
  });
});
