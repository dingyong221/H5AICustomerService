import { z } from 'zod';

import { apiErrorDetailSchema } from './errors.js';

export const requestIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);

export const apiSuccessEnvelopeSchema = <TSchema extends z.ZodType>(data: TSchema) =>
  z.object({
    data,
    request_id: requestIdSchema,
  });

export const apiErrorEnvelopeSchema = z.object({
  error: apiErrorDetailSchema,
  request_id: requestIdSchema,
});

export type ApiSuccessEnvelope<T> = {
  data: T;
  request_id: string;
};

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
