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
