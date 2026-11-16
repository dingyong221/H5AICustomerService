export type AuthoringTaskKind = 'draft.expand' | 'preview.reply';
export class AuthoringTaskError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_REQUEST'
      | 'NOT_FOUND'
      | 'INPUT_CHANGED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'TASK_NOT_READY'
      | 'RETRY_UNSAFE'
      | 'PREVIEW_SUPERSEDED'
      | 'QUEUE_FULL'
      | 'UNAVAILABLE'
      | 'WRITE_OUTCOME_UNKNOWN'
      | 'STALE_CLAIM',
  ) {
    super(code);
    this.name = 'AuthoringTaskError';
  }
}
