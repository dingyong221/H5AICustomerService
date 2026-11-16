import type { KnowledgeOrganizationProcessor } from './knowledge-organization-processor.js';
import { ModelCapacityError, type ModelRuntime } from './model-runtime.js';

/** Lazy knowledge heads use the existing fair queue and its single management slot. */
export class KnowledgeOrganizationScheduler {
  readonly #queued = new Set<string>();
  readonly #signal = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #refresh: Promise<void> | undefined;
  #again = false;
  #stopped = false;
  #cursor: string | undefined;
  #idleMs = 100;
  constructor(
    private readonly processor: KnowledgeOrganizationProcessor,
    private readonly runtime: ModelRuntime,
    private readonly ready: (ready: boolean) => void = () => undefined,
  ) {}
  start() {
    this.wake();
  }
  wake() {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#refresh) {
      this.#again = true;
      return;
    }
    this.#refresh = this.#fill()
      .catch(() => this.ready(false))
      .finally(() => {
        this.#refresh = undefined;
        if (this.#stopped) return;
        if (this.#again) {
          this.#again = false;
          this.wake();
        } else this.#timer = setTimeout(() => this.wake(), this.#idleMs);
      });
  }
  async stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#refresh;
  }
  async #fill() {
    // Read/reconcile expired leases even if unresolved supplier risk stops new admission.
    const heads = await this.processor.listRunnableMerchantHeads(new Date(), {
      limit: 64,
      ...(this.#cursor ? { afterMerchantId: this.#cursor } : {}),
    });
    if (!(await this.runtime.probeReadiness())) {
      this.ready(false);
      this.#idleMs = Math.min(2000, this.#idleMs * 2);
      return;
    }
    this.ready(true);
    this.#idleMs = heads.length ? 100 : Math.min(2000, this.#idleMs * 2);
    for (const head of heads) {
      if (this.#stopped || !this.runtime.accepting) return;
      if (this.#queued.has(head.merchantId)) {
        this.#cursor = head.merchantId;
        continue;
      }
      if (this.runtime.queued >= this.runtime.queueLimit) return;
      this.#queued.add(head.merchantId);
      try {
        const task = this.runtime.enqueueKnowledge(
          head.merchantId,
          this.#signal.signal,
          async (permit) => {
            try {
              return await this.processor.processOnce(
                permit.signal,
                head.merchantId,
                permit,
                (claim) => {
                  if (claim) this.runtime.bindKnowledgeClaim(permit, claim);
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
        void task.catch((e: unknown) => {
          this.#queued.delete(head.merchantId);
          if (!(e instanceof ModelCapacityError) && !this.#stopped) this.ready(false);
        });
      } catch (e) {
        this.#queued.delete(head.merchantId);
        if (!(e instanceof ModelCapacityError)) throw e;
        return;
      }
      this.#cursor = head.merchantId;
    }
    if (heads.length < 64) this.#cursor = undefined;
  }
}
