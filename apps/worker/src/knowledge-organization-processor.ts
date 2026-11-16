import { KnowledgeOrganizationError, MarketplaceAccessError } from '@h5cs/database';
import type {
  MySqlKnowledgeOrganizationRepository,
  KnowledgeOrganizationClaim,
} from '@h5cs/database';
import type { ConversationTurnGenerator } from './conversation-turn-processor.js';
import { generateKnowledgeOrganization } from './knowledge-organization.js';
import {
  ModelCapacityError,
  ModelRuntimePausedError,
  ModelUnknownOutcomeError,
  type ModelPermit,
} from './model-runtime.js';
export type KnowledgeOrganizationStore = Pick<
  MySqlKnowledgeOrganizationRepository,
  | 'claimNext'
  | 'listRunnableMerchantHeads'
  | 'complete'
  | 'fail'
  | 'releaseBeforeDispatch'
  | 'reconcile'
>;
export class KnowledgeOrganizationProcessor {
  constructor(
    private readonly store: KnowledgeOrganizationStore,
    private readonly generator: ConversationTurnGenerator,
    private readonly leaseOwner: string,
  ) {}
  public listRunnableMerchantHeads(
    now: Date,
    options?: { limit?: number; afterMerchantId?: string },
  ) {
    return this.store.listRunnableMerchantHeads(now, options);
  }
  public async processOnce(
    signal: AbortSignal,
    merchantId?: string,
    permit?: ModelPermit,
    onClaimed?: (claim: KnowledgeOrganizationClaim | null) => void,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const claim = await this.store.claimNext(
      new Date(),
      this.leaseOwner,
      merchantId ? { merchantId } : {},
    );
    onClaimed?.(claim);
    if (!claim) return false;
    if (signal.aborted) {
      await this.store.releaseBeforeDispatch(claim, new Date());
      return true;
    }
    const execution = AbortSignal.any([signal, AbortSignal.timeout(75000)]);
    let result: Awaited<ReturnType<typeof generateKnowledgeOrganization>>;
    try {
      result = await generateKnowledgeOrganization(this.generator, claim.text, execution, {
        merchantId: claim.merchantId,
        operation: 'organize',
        knowledgeClaim: claim,
        ...(permit ? { permit } : {}),
      });
      execution.throwIfAborted();
    } catch (e) {
      if (e instanceof ModelCapacityError || signal.aborted) {
        if (
          (await this.store.releaseBeforeDispatch(
            claim,
            new Date(),
            e instanceof ModelRuntimePausedError ? { reason: 'runtime_paused' } : undefined,
          )) === 'applied'
        )
          return true;
      }
      if (e instanceof ModelUnknownOutcomeError) {
        const current = await this.store.reconcile(claim);
        if (current.state !== 'processing' || current.currentGeneration !== claim.claimGeneration)
          return true;
      }
      await this.store.fail(
        claim,
        e instanceof ModelUnknownOutcomeError
          ? 'MODEL_RESULT_UNKNOWN'
          : e instanceof KnowledgeOrganizationError
            ? 'INPUT_CHANGED'
            : e instanceof MarketplaceAccessError
              ? e.code === 'quota_exhausted'
                ? 'MARKETPLACE_QUOTA_EXHAUSTED'
                : 'MARKETPLACE_NOT_ELIGIBLE'
              : execution.aborted
                ? 'MODEL_TIMEOUT'
                : 'MODEL_UNAVAILABLE',
        new Date(),
      );
      return true;
    }
    try {
      await this.store.complete(claim, result, new Date());
    } catch {
      const current = await this.store.reconcile(claim);
      if (current.state === 'processing' && current.currentGeneration === claim.claimGeneration)
        await this.store.fail(
          claim,
          ['unknown', 'dispatched'].includes(current.modelOutcome)
            ? 'MODEL_RESULT_UNKNOWN'
            : 'RESULT_FINALIZATION_FAILED',
          new Date(),
        );
    }
    return true;
  }
}
