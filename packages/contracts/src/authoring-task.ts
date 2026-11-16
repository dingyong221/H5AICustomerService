import { z } from 'zod';
import {
  isWritingField,
  parseWritingInput,
  parseWritingResult,
  type WritingField,
} from './writing.js';
const hex = z.string().regex(/^[a-f0-9]{32}$/u),
  digest = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.number().int().positive().max(2_147_483_646);
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
export const authoringRequestIdSchema = z.string().regex(/^authoring_[a-f0-9]{32}$/u);
const field = z.custom<WritingField>(isWritingField);
export const draftExpandRequestSchema = z
  .object({
    requestId: authoringRequestIdSchema,
    revision,
    field,
    brief: z.string(),
    currentText: z.string(),
    consent: z.literal(true),
  })
  .strict()
  .refine((x) => parseWritingInput(x) !== null);
export const previewReplyRequestSchema = z
  .object({
    requestId: authoringRequestIdSchema,
    revision,
    question: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((x) => !controls.test(x)),
  })
  .strict();
export const authoringTaskRetrySchema = z.object({ requestId: authoringRequestIdSchema }).strict();
export const authoringTaskCancelSchema = z.object({}).strict();
const base = {
  taskId: hex,
  state: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']),
  inputRevision: revision,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  modelOutcome: z.enum(['none', 'dispatched', 'succeeded', 'failed', 'unknown', 'not_dispatched']),
  stale: z.boolean(),
  canRetry: z.boolean(),
  error: z
    .object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u), retryable: z.boolean() })
    .strict()
    .optional(),
};
const draftTask = z
  .object({
    ...base,
    kind: z.literal('draft.expand'),
    field,
    inputFieldHash: digest,
    canUse: z.boolean(),
    result: z
      .object({
        options: z.array(z.string().min(1).max(4000)).min(2).max(3),
        reminders: z.array(z.string().min(1).max(200)).max(5),
      })
      .strict()
      .optional(),
  })
  .strict();
const previewTask = z
  .object({
    ...base,
    kind: z.literal('preview.reply'),
    inputFactsHash: digest,
    canJudge: z.boolean(),
    result: z
      .object({
        answer: z.string().min(1).max(8000),
        checkId: hex,
        evidence: z
          .array(
            z.object({ label: z.string().min(1).max(80), text: z.string().max(4000) }).strict(),
          )
          .max(6),
      })
      .strict()
      .optional(),
  })
  .strict();
export const authoringTaskSchema = z
  .discriminatedUnion('kind', [draftTask, previewTask])
  .superRefine((task, ctx) => {
    if (task.kind === 'draft.expand' && task.result && !parseWritingResult(task.result, task.field))
      ctx.addIssue({ code: 'custom', message: 'Invalid writing result' });
  });
export type DraftExpandRequest = z.infer<typeof draftExpandRequestSchema>;
export type PreviewReplyRequest = z.infer<typeof previewReplyRequestSchema>;
export type AuthoringTask = z.infer<typeof authoringTaskSchema>;
export type DraftExpandTask = Extract<AuthoringTask, { kind: 'draft.expand' }>;
export type PreviewReplyTask = Extract<AuthoringTask, { kind: 'preview.reply' }>;
