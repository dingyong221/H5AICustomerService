import { pollDelayMilliseconds } from './interaction-policy';
import type { AcceptedTurn, PublicAssistantApiClient, TurnResult } from './public-api-client';

const STREAM_GRACE_MS = 1000;
const RESULT_TIMEOUT_MS = 10000;

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Give SSE a short initial opportunity, then use only the durable result GET.
 * This avoids two writers applying differently aged results or execution states.
 * Aborting a read never cancels the server's business task.
 */
export async function observePublicTurn(input: {
  client: Pick<PublicAssistantApiClient, 'streamTurn' | 'readTurn'>;
  accepted: AcceptedTurn;
  clientMessageId: string;
  sessionHandle: string;
  signal: AbortSignal;
  onResult: (result: TurnResult) => void;
}): Promise<void> {
  const { client, accepted, clientMessageId, sessionHandle, signal, onResult } = input;
  signal.throwIfAborted();
  const stream = new AbortController();
  const grace = new AbortController();
  const abortStream = () => stream.abort();
  signal.addEventListener('abort', abortStream, { once: true });
  const original = { clientMessageId, sessionHandle, turnId: accepted.turnId };
  const terminal = (result: TurnResult) =>
    result.state === 'completed' || result.state === 'failed';
  // This promise always handles its rejection, even if a noncooperative transport
  // responds after the grace period or after the component has left.
  let finishInitial!: (terminal: boolean) => void;
  const initial = new Promise<boolean>((resolve) => {
    finishInitial = resolve;
  });
  void (async () => {
    try {
      for await (const result of client.streamTurn({
        ...original,
        eventsUrl: accepted.eventsUrl,
        signal: stream.signal,
      })) {
        if (signal.aborted || stream.signal.aborted) return;
        onResult(result);
        if (terminal(result)) {
          // Resolve before iterator.return()/reader cleanup: a terminal result
          // must not wait for a transport that is slow or unwilling to close.
          finishInitial(true);
          return;
        }
      }
    } catch {
      /* A failed read falls back to the original result endpoint. */
    } finally {
      finishInitial(false);
    }
  })();
  const deadlineSignal = AbortSignal.any([signal, grace.signal]);
  try {
    const completed = await Promise.race([
      initial,
      delay(STREAM_GRACE_MS, deadlineSignal).then(() => false),
    ]);
    signal.throwIfAborted();
    stream.abort();
    grace.abort();
    if (completed) return;
    let polls = 0;
    while (true) {
      signal.throwIfAborted();
      const request = new AbortController();
      const timeout = setTimeout(() => request.abort(), RESULT_TIMEOUT_MS);
      let result: TurnResult;
      try {
        const readSignal = AbortSignal.any([signal, request.signal]);
        result = await abortable(
          client.readTurn({
            ...original,
            resultUrl: accepted.resultUrl,
            signal: readSignal,
          }),
          readSignal,
        );
      } finally {
        clearTimeout(timeout);
      }
      signal.throwIfAborted();
      onResult(result);
      if (terminal(result)) return;
      await delay(pollDelayMilliseconds(polls++), signal);
    }
  } finally {
    stream.abort();
    grace.abort();
    signal.removeEventListener('abort', abortStream);
  }
}
