import { EXECUTION_STATE_HEADER, executionStateSchema } from '@h5cs/contracts';

// Call only after the existing repository/session authorization has succeeded.
// A control probe must never make a persisted result unreadable.
export async function withExecutionState(response: Response, read: () => Promise<unknown>) {
  let state = 'unavailable';
  try {
    const parsed = executionStateSchema.safeParse(await read());
    if (parsed.success) state = parsed.data;
  } catch {
    /* Retain the original task response. */
  }
  response.headers.set(EXECUTION_STATE_HEADER, state);
  return response;
}
