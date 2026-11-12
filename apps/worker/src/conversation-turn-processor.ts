import { MarketplaceAccessError } from '@h5cs/database';
import type { ConversationTurnClaim, ClaimMutationResult } from '@h5cs/database';

import { buildConversationPrompt, type ConversationPrompt } from './conversation-prompt.js';
import { ModelCapacityError, ModelUnknownOutcomeError, type ModelPermit } from './model-runtime.js';

export type ConversationTurnStore = Readonly<{
  claimNext: (
    now: Date,
    leaseOwner: string,
    options?: { merchantId?: string },
  ) => Promise<ConversationTurnClaim | null>;
  listRunnableMerchantHeads: (
    now: Date,
    options?: { limit?: number; afterMerchantId?: string },
  ) => Promise<readonly { merchantId: string; oldestReadyAt: Date }[]>;
  complete: (
    claim: ConversationTurnClaim,
    answer: string,
    now: Date,
  ) => Promise<ClaimMutationResult>;
  fail: (
    claim: ConversationTurnClaim,
    errorCode: string,
    now: Date,
  ) => Promise<ClaimMutationResult>;
  releaseBeforeDispatch: (claim: ConversationTurnClaim, now: Date) => Promise<ClaimMutationResult>;
  reconcile: (claim: ConversationTurnClaim) => Promise<{
    state: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'missing';
    currentGeneration: string | null;
    modelOutcome: 'none' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'not_dispatched';
  }>;
}>;

export type ConversationTurnGenerator = Readonly<{
  generate: (
    prompt: ConversationPrompt,
    signal: AbortSignal,
    context?: {
      merchantId: string;
      operation: string;
      claim?: ConversationTurnClaim;
      permit?: ModelPermit;
    },
  ) => Promise<string>;
}>;

export class ConversationTurnProcessor {
  public constructor(
    private readonly store: ConversationTurnStore,
    private readonly generator: ConversationTurnGenerator,
    private readonly leaseOwner: string,
  ) {}

  public listRunnableMerchantHeads(
    now: Date,
    options?: { limit?: number; afterMerchantId?: string },
  ): ReturnType<ConversationTurnStore['listRunnableMerchantHeads']> {
    return this.store.listRunnableMerchantHeads(now, options);
  }

  public async processOnce(
    signal: AbortSignal,
    merchantId?: string,
    permit?: ModelPermit,
    onClaimed?: (claim: ConversationTurnClaim | null) => void,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const claim = await this.store.claimNext(
      new Date(),
      this.leaseOwner,
      merchantId === undefined ? undefined : { merchantId },
    );
    onClaimed?.(claim);
    if (!claim) return false;
    if (signal.aborted) {
      await this.store.releaseBeforeDispatch(claim, new Date());
      return true;
    }
    let answer: string;
    const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(75_000)]);
    try {
      answer = await this.generator.generate(buildConversationPrompt(claim), turnSignal, {
        merchantId: claim.merchantId,
        operation: 'consumer',
        claim,
        ...(permit ? { permit } : {}),
      });
      if (turnSignal.aborted) throw new Error('Turn interrupted');
      if (
        answer.trim().length === 0 ||
        answer.length > 8_000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(answer)
      ) {
        throw new Error('Invalid model output');
      }
    } catch (error) {
      if (
        signal.aborted &&
        (await this.store.releaseBeforeDispatch(claim, new Date())) === 'applied'
      )
        return true;
      if (error instanceof ModelCapacityError) {
        // A final admission race is a temporary capacity shortage, not a model
        // failure. The runtime risk gate/backoff prevents immediate re-claim.
        await this.store.releaseBeforeDispatch(claim, new Date());
        return true;
      }
      if (error instanceof ModelUnknownOutcomeError) {
        const current = await this.store.reconcile(claim);
        if (current.state !== 'processing' || current.currentGeneration !== claim.claimGeneration)
          return true;
      }
      await this.store.fail(
        claim,
        error instanceof MarketplaceAccessError
          ? error.code === 'quota_exhausted'
            ? 'MARKETPLACE_QUOTA_EXHAUSTED'
            : 'MARKETPLACE_NOT_ELIGIBLE'
          : error instanceof ModelUnknownOutcomeError
            ? 'MODEL_RESULT_UNKNOWN'
            : signal.aborted
              ? 'WORKER_INTERRUPTED'
              : turnSignal.aborted
                ? 'MODEL_TIMEOUT'
                : 'MODEL_UNAVAILABLE',
        new Date(),
      );
      return true;
    }
    try {
      await this.store.complete(claim, answer.trim(), new Date());
    } catch {
      // A lost COMMIT response is not a failed turn. Reconcile before making
      // any mutation, and never use an old generation to overwrite a new one.
      const current = await this.store.reconcile(claim);
      if (current.state === 'processing' && current.currentGeneration === claim.claimGeneration) {
        await this.store.fail(
          claim,
          current.modelOutcome === 'unknown' || current.modelOutcome === 'dispatched'
            ? 'MODEL_RESULT_UNKNOWN'
            : 'TURN_FINALIZATION_FAILED',
          new Date(),
        );
      }
    }
    return true;
  }
}
