import type { ConversationTurnProcessor } from './conversation-turn-processor.js';
import { ModelCapacityError, type ModelRuntime } from './model-runtime.js';

// DB heads remain unclaimed while waiting in the same fair queue as HTTP work.
// Each selected head claims only its own merchant; a busy merchant can borrow
// both slots, and heads beyond the first page are visited with an ID cursor.
export class ConversationScheduler {
  readonly #queued = new Set<string>();
  readonly #signal = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #refresh: Promise<void> | undefined;
  #again = false;
  #stopped = false;
  #cursor: string | undefined;
  #idleMs = 100;

  public constructor(
    private readonly processor: ConversationTurnProcessor,
    private readonly runtime: ModelRuntime,
    private readonly ready: (ready: boolean) => void = () => undefined,
    private readonly maxIdleMs = 2_000,
  ) {}

  public start(): void {
    this.wake();
  }

  public wake(): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#refresh) {
      this.#again = true;
      return;
    }
    this.#refresh = this.#fill()
      .catch(() => {
        this.ready(false);
      })
      .finally(() => {
        this.#refresh = undefined;
        if (this.#stopped) return;
        if (this.#again) {
          this.#again = false;
          this.wake();
        } else this.#timer = setTimeout(() => this.wake(), this.#idleMs);
      });
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    // Do not abort selected turns here: ModelRuntime owns the drain budget.
    await this.#refresh;
  }

  async #fill(): Promise<void> {
    if (!(await this.runtime.probeReadiness())) {
      this.ready(false);
      this.#idleMs = Math.min(this.maxIdleMs, this.#idleMs * 2);
      return;
    }
    const heads = await this.processor.listRunnableMerchantHeads(new Date(), {
      limit: 64,
      ...(this.#cursor ? { afterMerchantId: this.#cursor } : {}),
    });
    this.ready(true);
    this.#idleMs = heads.length ? 100 : Math.min(this.maxIdleMs, this.#idleMs * 2);
    for (const head of heads) {
      if (this.#stopped || !this.runtime.accepting) return;
      if (this.#queued.has(head.merchantId)) {
        this.#cursor = head.merchantId;
        continue;
      }
      // A full local queue must not advance past heads that were never queued.
      // Resume at this head on the next free slot, even under a permanent
      // first-page backlog. Page observation alone is not merchant progress.
      if (this.runtime.queued >= this.runtime.queueLimit) return;
      this.#queued.add(head.merchantId);
      try {
        const task = this.runtime.enqueueConsumer(
          head.merchantId,
          this.#signal.signal,
          async (permit) => {
            try {
              return await this.processor.processOnce(
                permit.signal,
                head.merchantId,
                permit,
                (claim) => {
                  if (claim) this.runtime.bindClaim(permit, claim);
                  this.#queued.delete(head.merchantId);
                  this.wake();
                },
              );
            } finally {
              this.#queued.delete(head.merchantId);
              this.wake();
            }
          },
        );
        void task.catch((error: unknown) => {
          this.#queued.delete(head.merchantId);
          if (!(error instanceof ModelCapacityError) && !this.#stopped) this.ready(false);
        });
      } catch (error) {
        this.#queued.delete(head.merchantId);
        if (!(error instanceof ModelCapacityError)) throw error;
        return;
      }
      this.#cursor = head.merchantId;
    }
    if (heads.length < 64) this.#cursor = undefined;
  }
}
