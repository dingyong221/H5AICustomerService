export type RuntimeControlErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'NOT_CONTROLLABLE'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DISABLED'
  | 'UNAVAILABLE'
  | 'WRITE_OUTCOME_UNKNOWN';
export class RuntimeControlError extends Error {
  constructor(public readonly code: RuntimeControlErrorCode) {
    super(code);
    this.name = 'RuntimeControlError';
  }
}
/** Only thrown before any supplier/fee reservation, never for an uncertain COMMIT. */
export class RuntimeExecutionBlockedError extends Error {
  readonly code = 'RUNTIME_EXECUTION_PAUSED';
  constructor() {
    super('Runtime execution is paused');
    this.name = 'RuntimeExecutionBlockedError';
  }
}
