import { describe, expect, it } from 'vitest';

import {
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  livenessDataSchema,
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
});
