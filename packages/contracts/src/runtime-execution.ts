import { z } from 'zod';

export const EXECUTION_STATE_HEADER = 'X-H5CS-Execution-State';
export const executionStateSchema = z.enum([
  'runnable',
  'paused',
  'draining',
  'not-applicable',
  'unavailable',
]);
export type ExecutionState = z.infer<typeof executionStateSchema>;
const id = z.string().regex(/^[a-f0-9]{32}$/u);
export const runtimeScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('merchant'), merchantId: id }).strict(),
  z.object({ kind: z.literal('job'), jobId: id }).strict(),
]);
export type RuntimeScope = z.infer<typeof runtimeScopeSchema>;
export const runtimeRequestIdSchema = z.string().regex(/^runtime_[a-f0-9]{32}$/u);
export const runtimeRevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/u)
  .refine((v) => /^[0-9]+$/u.test(v) && BigInt(v) <= 18446744073709551615n);
export const runtimeControlRequestSchema = z
  .object({
    scope: runtimeScopeSchema,
    action: z.enum(['pause', 'resume']),
    expectedRevision: runtimeRevisionSchema,
    requestId: runtimeRequestIdSchema,
    reason: z
      .string()
      .trim()
      .min(5)
      .max(512)
      .refine((v) => !/[\u0000-\u001f\u007f]/u.test(v)),
    confirmed: z.literal(true),
  })
  .strict();
export type RuntimeControlRequest = z.infer<typeof runtimeControlRequestSchema>;
export type RuntimeControlState = 'active' | 'manually_stopped';
export type RuntimeControlReceipt = Readonly<{
  requestId: string;
  scope: RuntimeScope;
  scopeKey: string;
  action: 'pause' | 'resume';
  previousRevision: string;
  revision: string;
  state: RuntimeControlState;
  changedAt: string;
  auditId: string;
}>;
export type RuntimeControlView = Readonly<{
  scope: RuntimeScope;
  scopeKey: string;
  enabled: boolean;
  state: RuntimeControlState;
  revision: string;
  changedAt: string | null;
  actorId: string | null;
  reason: string | null;
  lastRequestId: string | null;
  effectiveState: ExecutionState;
  blockingScopes: readonly RuntimeScope[];
}>;
export type RuntimeObservationQuery = Readonly<{
  from: Date;
  to: Date;
  merchantId?: string;
  type?: 'conversation.turn' | 'knowledge.organize' | 'draft.expand' | 'preview.reply';
  limit?: number;
  cursor?: string;
}>;
export type RuntimeObservation = Readonly<{
  asOf: string;
  from: string;
  to: string;
  sampleCount: number;
  jobs: Readonly<{
    pending: number;
    duePending: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
    expiredLease: number;
    oldestPendingAt: string | null;
  }>;
  receipts: Readonly<{
    dispatched: number;
    unknown: number;
    succeeded: number;
    failed: number;
    notDispatched: number;
    unresolvedRiskCount: number;
  }>;
  reservations: Readonly<{
    reservedCalls: number;
    allocatedMerchantCount: number;
    unit: 'call_reservations_not_money';
  }>;
  tasks: readonly Readonly<{
    jobId: string;
    merchantId: string | null;
    type: string;
    state: string;
    modelOutcome: string;
    attempt: number;
    claimGeneration: string;
    createdAt: string;
    completedAt: string | null;
    lastErrorCode: string | null;
  }>[];
  nextCursor: string | null;
  timings: Readonly<{
    acceptedToCompletedMs: RuntimeTimingSummary;
    acceptedToDispatchRecordMs: RuntimeTimingSummary;
  }>;
}>;
export type RuntimeTimingSummary = Readonly<{
  sampleCount: number;
  excludedCount: number;
  examinedCount: number;
  truncated: boolean;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const workerRuntimeSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().regex(/^worker_[a-f0-9]{32}$/u),
    startedAt: z.iso.datetime(),
    observedAt: z.iso.datetime(),
    localModelActive: count,
    localQueued: count,
    accepting: z.boolean(),
    capacity: z.number().int().min(1).max(2),
    managementCapacity: z.literal(1),
    controlEnabled: z.boolean(),
    controlSchemaReady: z.boolean(),
    globalControlState: z.enum(['active', 'manually_stopped']).nullable(),
    unresolvedRiskCount: count.nullable(),
    riskProbeAt: z.iso.datetime().nullable(),
  })
  .strict();
export type WorkerRuntimeSnapshot = z.infer<typeof workerRuntimeSnapshotSchema>;
