import { describe, expect, it } from 'vitest';

import {
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  livenessDataSchema,
  oauthAuthorizationRequestSchema,
  oauthClientRegistrationRequestSchema,
  oauthTokenRequestSchema,
  onboardingEventRequestSchema,
  skillIntentRequestSchema,
  skillIntentResultSchema,
  tenantContextSchema,
  workBuddyAuthorizationCallbackQuerySchema,
  workBuddyAuthorizationResultSchema,
  workBuddyConsentRequestSchema,
  workBuddyMerchantSelectionRequestSchema,
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

  it('requires public OAuth clients, PKCE S256, and an explicit MCP resource', () => {
    expect(
      oauthClientRegistrationRequestSchema.parse({
        redirect_uris: ['http://127.0.0.1:43123/callback'],
        token_endpoint_auth_method: 'none',
      }).token_endpoint_auth_method,
    ).toBe('none');
    expect(
      oauthClientRegistrationRequestSchema.parse({
        redirect_uris: [
          'workbuddy://workbuddy/mcp/connector%3Ah5-ai-customer-service/oauth/callback',
        ],
      }).redirect_uris,
    ).toHaveLength(1);

    expect(
      oauthAuthorizationRequestSchema.parse({
        response_type: 'code',
        client_id: 'public-client-identifier',
        redirect_uri: 'http://127.0.0.1:43123/callback',
        scope: 'mcp:tools',
        state: 'opaque-csrf-state',
        code_challenge: 'A'.repeat(43),
        code_challenge_method: 'S256',
        resource: 'https://h5cs.example.test/mcp',
      }).code_challenge_method,
    ).toBe('S256');

    expect(() =>
      oauthTokenRequestSchema.parse({
        grant_type: 'authorization_code',
        client_id: 'public-client-identifier',
        client_secret: 'must-not-be-accepted',
        code: 'c'.repeat(32),
        redirect_uri: 'http://127.0.0.1:43123/callback',
        code_verifier: 'v'.repeat(43),
        resource: 'https://h5cs.example.test/mcp',
      }),
    ).toThrow();
  });

  it('accepts only opaque WorkBuddy transaction references on actionable results', () => {
    const transactionRef = 'a'.repeat(64);

    expect(
      workBuddyAuthorizationResultSchema.parse({
        authorization_url: 'https://www.workbuddy.cn/openapi/v2/oauth/authorize?state=opaque-state',
        status: 'signed_in',
        transaction_ref: transactionRef,
      }),
    ).toMatchObject({ status: 'signed_in', transaction_ref: transactionRef });
    expect(
      workBuddyAuthorizationResultSchema.parse({
        candidates: [
          { candidate_ref: 'candidate_one', display_name: '蓝天家电服务' },
          { candidate_ref: 'candidate_two', display_name: '青山维修' },
        ],
        status: 'merchant_selection_required',
        transaction_ref: transactionRef,
      }),
    ).toMatchObject({
      candidates: [{ candidate_ref: 'candidate_one' }, { candidate_ref: 'candidate_two' }],
      status: 'merchant_selection_required',
    });

    for (const invalidReference of ['transaction_01', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(() =>
        workBuddyAuthorizationResultSchema.parse({
          status: 'consent_required',
          transaction_ref: invalidReference,
        }),
      ).toThrow();
    }
  });

  it('rejects duplicate candidates and mutation bodies without an exact transaction reference', () => {
    const transactionRef = 'b'.repeat(64);
    const duplicateCandidate = { candidate_ref: 'candidate_one', display_name: '蓝天家电服务' };

    expect(() =>
      workBuddyAuthorizationResultSchema.parse({
        candidates: [duplicateCandidate, duplicateCandidate],
        status: 'merchant_selection_required',
        transaction_ref: transactionRef,
      }),
    ).toThrow();
    expect(() => workBuddyConsentRequestSchema.parse({ decision: 'grant' })).toThrow();
    expect(() =>
      workBuddyMerchantSelectionRequestSchema.parse({ candidate_ref: 'candidate_one' }),
    ).toThrow();
  });

  it('keeps callback parameters separate from trusted authorization state', () => {
    expect(
      workBuddyAuthorizationCallbackQuerySchema.parse({
        code: 'one-time-code',
        state: 's'.repeat(32),
      }),
    ).toEqual({ code: 'one-time-code', state: 's'.repeat(32) });
    expect(() =>
      workBuddyAuthorizationCallbackQuerySchema.parse({
        code: 'one-time-code',
        open_id: 'caller-controlled',
        state: 's'.repeat(32),
      }),
    ).toThrow();
  });
});
