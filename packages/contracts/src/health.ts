import { z } from 'zod';

export const healthCheckStateSchema = z.enum(['up', 'down', 'unconfigured']);

export const livenessDataSchema = z.object({
  status: z.literal('ok'),
  service: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
});

export const readinessDataSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  service: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  checks: z.object({
    database: z.object({
      status: healthCheckStateSchema,
      latency_ms: z.number().nonnegative().optional(),
      reason: z.string().min(1).optional(),
    }),
    conversation: z
      .object({
        status: healthCheckStateSchema,
        reason: z.string().min(1).optional(),
      })
      .optional(),
  }),
});

export const platformInfoDataSchema = z.object({
  service: z.literal('h5-ai-customer-service'),
  api_version: z.literal('v1'),
  environment: z.string().min(1),
});

export type LivenessData = z.infer<typeof livenessDataSchema>;
export type ReadinessData = z.infer<typeof readinessDataSchema>;
export type PlatformInfoData = z.infer<typeof platformInfoDataSchema>;
