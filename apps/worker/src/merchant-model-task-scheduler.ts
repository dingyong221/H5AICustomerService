import { ModelCapacityError, type ModelRuntime, type ModelPermit } from './model-runtime.js';
export type MerchantModelTaskHead = Readonly<{
  key: string;
  merchantId: string;
  operation: 'organize' | 'writing' | 'preview';
}>;
export type MerchantModelTaskSource = Readonly<{
  heads: (now: Date, cursor?: string) => Promise<readonly MerchantModelTaskHead[]>;
  run: (
    head: MerchantModelTaskHead,
    permit: ModelPermit,
    onClaimed: () => void,
  ) => Promise<boolean>;
}>;
/** Shared scheduler algorithm; admitted work enters the same ModelRuntime queue. */
export class MerchantModelTaskScheduler {
  readonly #queued = new Set<string>();
  readonly #signal = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #refresh: Promise<void> | undefined;
  #again = false;
  #stopped = false;
  #cursor: string | undefined;
  #idleMs = 100;
  constructor(
    private readonly source: MerchantModelTaskSource,
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
    const heads = await this.source.heads(new Date(), this.#cursor);
    if (!(await this.runtime.probeReadiness())) {
      this.ready(false);
      this.#idleMs = Math.min(2000, this.#idleMs * 2);
      return;
    }
    this.ready(true);
    this.#idleMs = heads.length ? 100 : Math.min(2000, this.#idleMs * 2);
    for (const head of heads) {
      if (this.#stopped || !this.runtime.accepting) return;
      if (this.#queued.has(head.key)) {
        this.#cursor = head.key;
        continue;
      }
      if (this.runtime.queued >= this.runtime.queueLimit) return;
      this.#queued.add(head.key);
      try {
        const run = async (permit: ModelPermit) => {
          try {
            return await this.source.run(head, permit, () => {
              this.#queued.delete(head.key);
              this.wake();
            });
          } finally {
            this.#queued.delete(head.key);
            this.wake();
          }
        };
        const task =
          head.operation === 'organize'
            ? this.runtime.enqueueKnowledge(head.merchantId, this.#signal.signal, run)
            : this.runtime.enqueueAuthoring(
                head.merchantId,
                head.operation,
                this.#signal.signal,
                run,
              );
        void task.catch((e: unknown) => {
          this.#queued.delete(head.key);
          if (!(e instanceof ModelCapacityError) && !this.#stopped) this.ready(false);
        });
      } catch (e) {
        this.#queued.delete(head.key);
        if (!(e instanceof ModelCapacityError)) throw e;
        return;
      }
      this.#cursor = head.key;
    }
    if (heads.length < 64) this.#cursor = undefined;
  }
}
