import { z } from 'zod';

export const workBuddyTransactionRefSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const workBuddyMerchantCandidateRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9:_-]{0,190})$/u);

export const workBuddyAuthorizationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('sign_in_required') }).strict(),
  z
    .object({
      authorization_url: z.string().url().max(2_048),
      status: z.literal('signed_in'),
      transaction_ref: workBuddyTransactionRefSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('binding_required'),
      transaction_ref: workBuddyTransactionRefSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('consent_required'),
      transaction_ref: workBuddyTransactionRefSchema,
    })
    .strict(),
  z
    .object({
      candidates: z
        .array(
          z
            .object({
              candidate_ref: workBuddyMerchantCandidateRefSchema,
              display_name: z.string().trim().min(1).max(80),
            })
            .strict(),
        )
        .max(20),
      status: z.literal('merchant_selection_required'),
      transaction_ref: workBuddyTransactionRefSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        new Set(value.candidates.map((candidate) => candidate.candidate_ref)).size !==
        value.candidates.length
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Merchant candidate references must be unique',
          path: ['candidates'],
        });
      }
    }),
  z.object({ status: z.literal('connected') }).strict(),
  z.object({ status: z.literal('conflict') }).strict(),
  z.object({ status: z.literal('revoked') }).strict(),
  z.object({ status: z.literal('authorization_failed') }).strict(),
]);

export const workBuddyAuthorizationStatusQuerySchema = z
  .object({ transaction_ref: workBuddyTransactionRefSchema.optional() })
  .strict();

export const workBuddyAuthorizationCallbackQuerySchema = z
  .object({
    code: z.string().regex(/^\S{8,2048}$/u),
    state: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/u),
  })
  .strict();

export const workBuddyConsentRequestSchema = z
  .object({
    decision: z.enum(['grant', 'deny']),
    transaction_ref: workBuddyTransactionRefSchema,
  })
  .strict();

export const workBuddyMerchantSelectionRequestSchema = z
  .object({
    candidate_ref: workBuddyMerchantCandidateRefSchema,
    transaction_ref: workBuddyTransactionRefSchema,
  })
  .strict();

export type WorkBuddyAuthorizationResult = z.infer<typeof workBuddyAuthorizationResultSchema>;
export type WorkBuddyConsentRequest = z.infer<typeof workBuddyConsentRequestSchema>;
export type WorkBuddyMerchantSelectionRequest = z.infer<
  typeof workBuddyMerchantSelectionRequestSchema
>;
