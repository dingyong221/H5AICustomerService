import { z } from 'zod';

export const onboardingStateSchema = z.enum([
  'industry',
  'materials',
  'policy',
  'confirmation',
  'generating',
  'manageable',
  'cancelled',
]);

export const onboardingSessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/iu, 'onboarding session ID must be exactly 32 hexadecimal characters');

export const onboardingMissingItemSchema = z.object({
  code: z.enum([
    'industry_code',
    'business_name',
    'business_description',
    'offering',
    'material_reference',
    'pricing_policy',
    'promotion_policy',
    'insufficient_fact_policy',
    'merchant_confirmation',
  ]),
  message: z.string().min(1),
});

const createCustomerServiceIntentSchema = z
  .object({
    intent: z.literal('create_customer_service'),
    resume_session_id: onboardingSessionIdSchema.optional(),
  })
  .strict();

const openManagementConsoleIntentSchema = z
  .object({
    intent: z.literal('open_management_console'),
    assistant_ref: z
      .string()
      .regex(/^[0-9a-f]{32}$/u)
      .optional(),
  })
  .strict();

const helpIntentSchema = z
  .object({
    intent: z.literal('help'),
    topic: z.enum(['create_customer_service', 'open_management_console']).optional(),
  })
  .strict();

export const skillIntentRequestSchema = z.discriminatedUnion('intent', [
  createCustomerServiceIntentSchema,
  openManagementConsoleIntentSchema,
  helpIntentSchema,
]);

export const skillIntentResultSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('continue_onboarding'),
    onboarding_session_id: onboardingSessionIdSchema,
    state: onboardingStateSchema,
    missing_items: z.array(onboardingMissingItemSchema),
  }),
  z.object({
    action: z.literal('open_management_console'),
    url: z.string().url(),
    assistant: z.object({
      assistant_ref: z.string().min(1).max(128),
      display_name: z.string().min(1).max(200),
      status: z.string().min(1).max(32),
    }),
  }),
  z.object({
    action: z.literal('start_first_onboarding'),
    reason: z.literal('no_assistant'),
  }),
  z.object({
    action: z.literal('select_assistant'),
    url: z.string().url(),
    selection_required: z.literal(true),
    assistants: z
      .array(
        z.object({
          assistant_ref: z.string().min(1).max(128),
          display_name: z.string().min(1).max(200),
          status: z.string().min(1).max(32),
        }),
      )
      .min(2),
  }),
  z.object({
    action: z.literal('help'),
    supported_intents: z.tuple([
      z.literal('create_customer_service'),
      z.literal('open_management_console'),
    ]),
  }),
]);

export type SkillIntentRequest = z.infer<typeof skillIntentRequestSchema>;
export type SkillIntentResult = z.infer<typeof skillIntentResultSchema>;
export type OnboardingMissingItemContract = z.infer<typeof onboardingMissingItemSchema>;

const offeringSchema = z
  .object({
    kind: z.enum(['product', 'goods', 'service']),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(4_000),
    targetAudience: z.string().trim().min(1).max(1_000),
  })
  .strict();

const materialReferenceSchema = z
  .object({
    kind: z.enum(['faq', 'text', 'pdf', 'other']),
    reference: z.string().trim().min(1).max(1_024),
    summary: z.string().trim().min(1).max(4_000),
  })
  .strict();

const effectiveRangeShape = {
  conditions: z.string().trim().min(1).max(2_000).optional(),
  effectiveFrom: z.string().datetime({ offset: true }).optional(),
  effectiveUntil: z.string().datetime({ offset: true }).optional(),
};

const priceFactSchema = z
  .object({
    offeringName: z.string().trim().min(1).max(200),
    amount: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d{1,4})?$/u),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/u),
    ...effectiveRangeShape,
  })
  .strict();

const promotionFactSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(4_000),
    ...effectiveRangeShape,
  })
  .strict();

const pricingPolicySchema = z.discriminatedUnion('availability', [
  z
    .object({
      availability: z.literal('provided'),
      facts: z.array(priceFactSchema).min(1).max(200),
    })
    .strict(),
  z
    .object({ availability: z.literal('none_confirmed'), facts: z.array(priceFactSchema).max(0) })
    .strict(),
  z.object({ availability: z.literal('unknown'), facts: z.array(priceFactSchema).max(0) }).strict(),
]);

const promotionPolicySchema = z.discriminatedUnion('availability', [
  z
    .object({
      availability: z.literal('provided'),
      facts: z.array(promotionFactSchema).min(1).max(200),
    })
    .strict(),
  z
    .object({
      availability: z.literal('none_confirmed'),
      facts: z.array(promotionFactSchema).max(0),
    })
    .strict(),
  z
    .object({ availability: z.literal('unknown'), facts: z.array(promotionFactSchema).max(0) })
    .strict(),
]);

export const onboardingEventRequestSchema = z
  .object({
    event: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('provide_industry'),
          industryCode: z.string().trim().min(1).max(64),
        })
        .strict(),
      z
        .object({
          type: z.literal('provide_materials'),
          businessName: z.string().trim().min(1).max(200).optional(),
          businessDescription: z.string().trim().min(1).max(4_000).optional(),
          offerings: z.array(offeringSchema).max(200).optional(),
          materials: z.array(materialReferenceSchema).max(200).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('provide_policy'),
          pricingPolicy: pricingPolicySchema.optional(),
          promotionPolicy: promotionPolicySchema.optional(),
          insufficientFactPolicy: z
            .enum(['say_unconfirmed', 'collect_lead', 'contact_merchant'])
            .optional(),
        })
        .strict(),
      z.object({ type: z.literal('confirm') }).strict(),
      z.object({ type: z.literal('cancel') }).strict(),
      z.object({ type: z.literal('resume') }).strict(),
    ]),
  })
  .strict();

export type OnboardingEventRequest = z.infer<typeof onboardingEventRequestSchema>;
