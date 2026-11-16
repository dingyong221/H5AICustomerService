export type KnowledgeOrganizationState =
  'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type KnowledgeModelOutcome =
  'none' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'not_dispatched';
export type KnowledgeSourceReference = Readonly<{
  id: string;
  revision: number;
  contentHash: string;
  name: string;
}>;
export type KnowledgeOrganizationResult = Readonly<{
  summary: string;
  warnings: readonly string[];
}>;
export type KnowledgeOrganizationTask = Readonly<{
  taskId: string;
  state: KnowledgeOrganizationState;
  inputRevision: number;
  sources: readonly KnowledgeSourceReference[];
  createdAt: string;
  updatedAt: string;
  modelOutcome: KnowledgeModelOutcome;
  stale: boolean;
  canRetry: boolean;
  canApply: boolean;
  result?: KnowledgeOrganizationResult;
  error?: Readonly<{ code: string; retryable: boolean }>;
  appliedRevision?: number;
}>;
export class KnowledgeOrganizationError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_REQUEST'
      | 'NOT_FOUND'
      | 'INPUT_CHANGED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'TASK_NOT_READY'
      | 'RETRY_UNSAFE'
      | 'UNAVAILABLE'
      | 'WRITE_OUTCOME_UNKNOWN'
      | 'STALE_CLAIM',
  ) {
    super(code);
    this.name = 'KnowledgeOrganizationError';
  }
}
export const safeKnowledgeRetry = (state: string, outcome: KnowledgeModelOutcome): boolean =>
  state === 'failed' && ['none', 'not_dispatched', 'failed'].includes(outcome);
