import type { ConversationTurnClaim, KnowledgeOrganizationClaim } from '@h5cs/database';
import { settlesWithin } from './shutdown-budget.js';
import { abortable } from './abortable.js';

export type ModelOperation = 'consumer' | 'preview' | 'writing' | 'organize';
export type ModelContext = Readonly<{
  merchantId: string;
  operation: ModelOperation;
  claim?: ConversationTurnClaim;
  knowledgeClaim?: KnowledgeOrganizationClaim;
  permit?: ModelPermit;
}>;
export type ModelAttemptStore = Readonly<{
  unknownRiskCount: () => Promise<number>;
  markDispatch: (
    context: Omit<ModelContext, 'permit'>,
    now: Date,
  ) => Promise<{ attemptId: string }>;
  recordOutcome: (
    attemptId: string,
    outcome: 'succeeded' | 'failed' | 'unknown' | 'not_dispatched',
    now: Date,
    providerRequestId?: string,
  ) => Promise<void>;
}>;

export class ModelCapacityError extends Error {}
export class ModelUnknownOutcomeError extends Error {}
export class ModelResponseError extends Error {}

// A permit reserves local preparation capacity. It is not a supplier dispatch or
// fee reservation: both happen only inside dispatch(), immediately before fetch.
export type ModelPermit = Readonly<{ signal: AbortSignal }>;
type Work = {
  merchantId: string;
  operation: ModelOperation;
  signal: AbortSignal;
  run: (permit: ModelPermit) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  removeAbort: () => void;
  interactiveBypasses: number;
};

export class ModelRuntime {
  readonly #queue: Work[] = [];
  readonly #permits = new Map<
    ModelPermit,
    { merchantId: string; operation: ModelOperation; used: boolean; claimKey?: string }
  >();
  readonly #abort = new AbortController();
  readonly #running = new Set<Promise<unknown>>();
  #managementActive = 0;
  #lastMerchant: string | undefined;
  #accepting = true;
  #admission: Promise<void> = Promise.resolve();
  #modelActive = 0;
  #pumping = false;
  #pumpAgain = false;
  #retryTimer: NodeJS.Timeout | undefined;
  #admissionRetryAt = 0;

  public constructor(
    private readonly attempts: ModelAttemptStore,
    public readonly capacity = 2,
    public readonly queueLimit = 64,
    private readonly riskLimit = 2,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 2)
      throw new RangeError('The single-instance model capacity must be 1 or 2');
    if (!Number.isSafeInteger(queueLimit) || queueLimit < 1 || riskLimit < capacity)
      throw new RangeError('Invalid model queue or risk limit');
  }

  public get accepting(): boolean {
    return this.#accepting;
  }
  public get queued(): number {
    return this.#queue.length;
  }
  public get active(): number {
    return this.#modelActive;
  }

  public async probeReadiness(): Promise<boolean> {
    // This also verifies the receipt schema before any DB task is claimed.
    // Known local calls are normal load; unresolved receipts left behind by
    // an earlier process or an unknown outcome must keep the brake visible.
    const unresolved = await this.attempts.unknownRiskCount();
    return unresolved - this.#modelActive < this.riskLimit;
  }

  public assertAccepting(permit?: ModelPermit): void {
    if (!this.#accepting && (!permit || !this.#permits.has(permit)))
      throw new ModelCapacityError('Model runtime is draining');
  }

  public bindClaim(permit: ModelPermit, claim: ConversationTurnClaim): void {
    const scope = this.#permits.get(permit);
    if (
      !scope ||
      scope.operation !== 'consumer' ||
      scope.merchantId !== claim.merchantId ||
      scope.used ||
      scope.claimKey
    )
      throw new ModelCapacityError('Model permit claim scope mismatch');
    scope.claimKey = `${claim.jobId}:${claim.claimGeneration}`;
  }

  public enqueueConsumer<T>(
    merchantId: string,
    signal: AbortSignal,
    run: (permit: ModelPermit) => Promise<T>,
  ): Promise<T> {
    return this.#enqueue(merchantId, 'consumer', signal, run);
  }

  public bindKnowledgeClaim(permit: ModelPermit, claim: KnowledgeOrganizationClaim): void {
    const scope = this.#permits.get(permit);
    if (
      !scope ||
      scope.operation !== 'organize' ||
      scope.merchantId !== claim.merchantId ||
      scope.used ||
      scope.claimKey
    )
      throw new ModelCapacityError('Knowledge permit claim scope mismatch');
    scope.claimKey = `knowledge:${claim.jobId}:${claim.claimGeneration}`;
  }

  public enqueueKnowledge<T>(
    merchantId: string,
    signal: AbortSignal,
    run: (permit: ModelPermit) => Promise<T>,
  ): Promise<T> {
    return this.#enqueue(merchantId, 'organize', signal, run);
  }

  public async dispatch<T>(
    context: ModelContext,
    signal: AbortSignal,
    call: (signal: AbortSignal) => Promise<{ value: T; providerRequestId?: string }>,
  ): Promise<T> {
    const invoke = async (permit: ModelPermit): Promise<T> => {
      const combined = AbortSignal.any([signal, permit.signal]);
      combined.throwIfAborted();
      // Serialize persistent risk admission and markDispatch within this one
      // model executor. Open dispatched receipts survive process restarts.
      const prior = this.#admission;
      let release!: () => void;
      this.#admission = new Promise<void>((resolve) => {
        release = resolve;
      });
      let attemptId: string;
      try {
        await prior;
        combined.throwIfAborted();
        if ((await this.attempts.unknownRiskCount()) >= this.riskLimit) {
          this.#admissionRetryAt = Date.now() + 100;
          throw new ModelCapacityError('Unresolved supplier call risk limit reached');
        }
        combined.throwIfAborted();
        const { permit: _permit, ...dispatchContext } = context;
        try {
          attemptId = (await this.attempts.markDispatch(dispatchContext, new Date())).attemptId;
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'MODEL_DISPATCH_UNKNOWN'
          )
            throw new ModelUnknownOutcomeError('Dispatch reservation requires reconciliation');
          throw error;
        }
      } finally {
        release();
      }
      if (combined.aborted) {
        try {
          await this.attempts.recordOutcome(attemptId, 'not_dispatched', new Date());
        } catch {
          throw new ModelUnknownOutcomeError('Non-dispatch persistence is unconfirmed');
        }
        combined.throwIfAborted();
      }
      this.#modelActive += 1;
      this.#pump();
      let result: { value: T; providerRequestId?: string };
      try {
        try {
          result = await abortable(call(combined), combined);
        } finally {
          // An aborted/unknown local call is no longer known active load, even
          // when its outcome write hangs. Do not subtract it from persisted risk.
          this.#modelActive -= 1;
        }
      } catch (error) {
        const outcome = error instanceof ModelResponseError ? 'failed' : 'unknown';
        try {
          await this.attempts.recordOutcome(attemptId, outcome, new Date());
        } catch {
          throw new ModelUnknownOutcomeError('Supplier outcome persistence is unconfirmed');
        }
        if (outcome === 'unknown')
          throw new ModelUnknownOutcomeError('Supplier outcome is unknown');
        throw error;
      }
      try {
        await this.attempts.recordOutcome(
          attemptId,
          'succeeded',
          new Date(),
          result.providerRequestId,
        );
      } catch {
        throw new ModelUnknownOutcomeError('Supplier outcome persistence is unconfirmed');
      }
      return result.value;
    };
    if (context.permit) {
      const scope = this.#permits.get(context.permit);
      if (
        !scope ||
        scope.used ||
        scope.merchantId !== context.merchantId ||
        scope.operation !== context.operation ||
        (context.operation === 'consumer' &&
          (!context.claim ||
            scope.claimKey !== `${context.claim.jobId}:${context.claim.claimGeneration}`)) ||
        (context.knowledgeClaim &&
          (context.operation !== 'organize' ||
            scope.claimKey !==
              `knowledge:${context.knowledgeClaim.jobId}:${context.knowledgeClaim.claimGeneration}`)) ||
        (context.operation === 'organize' &&
          scope.claimKey !== undefined &&
          !context.knowledgeClaim)
      )
        throw new ModelCapacityError('Invalid model permit scope or reuse');
      scope.used = true;
      return invoke(context.permit);
    }
    return this.#enqueue(context.merchantId, context.operation, signal, (permit) => {
      const scope = this.#permits.get(permit)!;
      scope.used = true;
      return invoke(permit);
    });
  }

  public stopAdmission(): void {
    this.#accepting = false;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    for (const work of this.#queue.splice(0)) {
      work.removeAbort();
      work.reject(new ModelCapacityError('Model runtime is draining'));
    }
  }

  public async drain(timeoutMs = 85_000, finalizationMs = 5_000): Promise<'drained' | 'aborted'> {
    this.stopAdmission();
    if (!this.#running.size) return 'drained';
    const finished = Promise.allSettled([...this.#running]);
    if (await settlesWithin(finished, timeoutMs)) return 'drained';
    this.#abort.abort(new Error('Worker drain budget exceeded'));
    // DB calls are not guaranteed to honor AbortSignal. Leave any unconfirmed
    // receipt/lease intact for recovery rather than waiting forever or clearing it.
    await settlesWithin(finished, finalizationMs);
    return 'aborted';
  }

  #enqueue<T>(
    merchantId: string,
    operation: ModelOperation,
    signal: AbortSignal,
    run: (permit: ModelPermit) => Promise<T>,
  ): Promise<T> {
    this.assertAccepting();
    signal.throwIfAborted();
    if (this.#queue.length >= this.queueLimit) throw new ModelCapacityError('Model queue is full');
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#queue.indexOf(work);
        if (index >= 0) {
          this.#queue.splice(index, 1);
          reject(signal.reason);
        }
      };
      const work: Work = {
        merchantId,
        operation,
        signal,
        run,
        resolve: (value) => resolve(value as T),
        reject,
        removeAbort: () => signal.removeEventListener('abort', onAbort),
        interactiveBypasses: 0,
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#queue.push(work);
      this.#pump();
    });
  }

  #pump(): void {
    if (!this.#accepting) return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    if (this.#pumping) {
      this.#pumpAgain = true;
      return;
    }
    this.#pumping = true;
    void this.#pumpAvailable()
      .catch(() => this.#scheduleRetry())
      .finally(() => {
        this.#pumping = false;
        if (this.#pumpAgain) {
          this.#pumpAgain = false;
          this.#pump();
        }
      });
  }

  #scheduleRetry(delayMs = 100): void {
    if (this.#retryTimer || !this.#accepting || !this.#queue.length) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#pump();
    }, delayMs);
  }

  async #pumpAvailable(): Promise<void> {
    while (this.#accepting && this.#running.size < this.capacity) {
      if (Date.now() < this.#admissionRetryAt) {
        this.#scheduleRetry(this.#admissionRetryAt - Date.now());
        return;
      }
      if (!this.#queue.some((work) => !management(work.operation) || !this.#managementActive))
        return;
      // Persisted unknown/foreign dispatched receipts occupy effective capacity
      // before any lazy consumer head receives a permit or a ticking DB lease.
      const unresolved = await this.attempts.unknownRiskCount();
      if (!this.#accepting) return;
      const outsideRisk = Math.max(0, unresolved - this.#modelActive);
      const effectiveCapacity = Math.max(0, Math.min(this.capacity, this.riskLimit - outsideRisk));
      if (this.#running.size >= effectiveCapacity) {
        this.#scheduleRetry();
        return;
      }
      const eligible = this.#queue.filter(
        (work) => !management(work.operation) || !this.#managementActive,
      );
      if (!eligible.length) return;
      // Every waiting merchant is visible, including lazy unclaimed DB heads.
      // Age each waiting management item after three interactive grants for
      // its own merchant. Other merchants' management grants cannot reset it.
      const merchants = [...new Set(eligible.map((work) => work.merchantId))].sort();
      const merchant =
        (this.#lastMerchant === undefined
          ? undefined
          : merchants.find((id) => id > this.#lastMerchant!)) ?? merchants[0]!;
      const sameMerchant = eligible.filter((work) => work.merchantId === merchant);
      const aged = sameMerchant.find(
        (work) => management(work.operation) && work.interactiveBypasses >= 3,
      );
      const selected =
        aged ?? sameMerchant.find((work) => !management(work.operation)) ?? sameMerchant[0]!;
      this.#queue.splice(this.#queue.indexOf(selected), 1);
      selected.removeAbort();
      this.#lastMerchant = selected.merchantId;
      const isManagement = management(selected.operation);
      if (isManagement) this.#managementActive += 1;
      else
        for (const work of sameMerchant) {
          if (management(work.operation)) work.interactiveBypasses += 1;
        }
      const permit: ModelPermit = {
        signal: AbortSignal.any([selected.signal, this.#abort.signal]),
      };
      this.#permits.set(permit, {
        merchantId: selected.merchantId,
        operation: selected.operation,
        used: false,
      });
      const running = Promise.resolve().then(() => selected.run(permit));
      this.#running.add(running);
      void running.then(selected.resolve, selected.reject).finally(() => {
        this.#running.delete(running);
        this.#permits.delete(permit);
        if (isManagement) this.#managementActive -= 1;
        this.#pump();
      });
    }
  }
}

const management = (operation: ModelOperation): boolean =>
  operation === 'writing' || operation === 'organize';
