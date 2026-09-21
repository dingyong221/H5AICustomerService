import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'BINDING_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'TURN_IN_PROGRESS',
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'MERCHANT_SELECTION_REQUIRED',
  'GENERATION_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'DATABASE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorDetailSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;
