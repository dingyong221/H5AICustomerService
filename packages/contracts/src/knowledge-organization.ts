import { z } from 'zod';
const hex = z.string().regex(/^[a-f0-9]{32}$/u);
const revision = z.number().int().positive().max(2_147_483_646);
export const knowledgeOrganizationRequestIdSchema = z.string().regex(/^organize_[a-f0-9]{32}$/u);
export const knowledgeOrganizationRequestSchema = z
  .object({
    requestId: knowledgeOrganizationRequestIdSchema,
    revision,
    sourceIds: z
      .array(hex)
      .min(1)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length),
    consent: z.literal(true),
  })
  .strict();
export const knowledgeOrganizationRetrySchema = z
  .object({ requestId: knowledgeOrganizationRequestIdSchema })
  .strict();
export const knowledgeOrganizationCancelSchema = z.object({}).strict();
export const knowledgeOrganizationApplySchema = z
  .object({
    revision,
    summary: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .refine((text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)),
    mode: z.enum(['append', 'replace']),
    confirmed: z.literal(true),
  })
  .strict();
export const knowledgeOrganizationTaskSchema = z
  .object({
    taskId: hex,
    state: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']),
    inputRevision: revision,
    sources: z
      .array(
        z
          .object({
            id: hex,
            revision,
            contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
            name: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    modelOutcome: z.enum([
      'none',
      'dispatched',
      'succeeded',
      'failed',
      'unknown',
      'not_dispatched',
    ]),
    stale: z.boolean(),
    canRetry: z.boolean(),
    canApply: z.boolean(),
    result: z
      .object({
        summary: z.string().min(1).max(4000),
        warnings: z.array(z.string().min(1).max(200)).max(10),
      })
      .strict()
      .optional(),
    error: z
      .object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u), retryable: z.boolean() })
      .strict()
      .optional(),
    appliedRevision: revision.optional(),
  })
  .strict();
export type KnowledgeOrganizationRequest = z.infer<typeof knowledgeOrganizationRequestSchema>;
export type KnowledgeOrganizationTask = z.infer<typeof knowledgeOrganizationTaskSchema>;
export type KnowledgeOrganizationApply = z.infer<typeof knowledgeOrganizationApplySchema>;
