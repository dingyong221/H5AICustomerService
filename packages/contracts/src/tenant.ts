import { z } from 'zod';

const opaqueIdSchema = z.string().min(1).max(128);

export const tenantContextSchema = z.object({
  merchant_id: opaqueIdSchema,
  assistant_id: opaqueIdSchema.optional(),
  actor_id: opaqueIdSchema,
  actor_type: z.enum(['merchant_user', 'platform_operator', 'skill', 'visitor', 'service']),
  scopes: z.array(z.string().min(1).max(128)).default([]),
});

export type TenantContext = z.infer<typeof tenantContextSchema>;
