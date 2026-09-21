export type PollAction = (signal: AbortSignal) => Promise<void>;

export class PollLoop {
  readonly #abortController = new AbortController();
  readonly #intervalMs: number;
  readonly #pollAction: PollAction;
  #inFlight: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  public constructor(intervalMs: number, pollAction: PollAction) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new RangeError('Poll interval must be an integer of at least 100ms');
    }
    this.#intervalMs = intervalMs;
    this.#pollAction = pollAction;
  }

  public async runOnce(): Promise<void> {
    if (this.#inFlight !== undefined) return this.#inFlight;

    this.#inFlight = this.#pollAction(this.#abortController.signal).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  public start(): void {
    if (this.#timer !== undefined || this.#abortController.signal.aborted) return;
    this.#schedule();
  }

  public async stop(): Promise<void> {
    this.#abortController.abort();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#inFlight;
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.runOnce().finally(() => {
        if (!this.#abortController.signal.aborted) this.#schedule();
      });
    }, this.#intervalMs);
  }
}
