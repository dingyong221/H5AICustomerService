import {
  AuthoringTaskError,
  MarketplaceAccessError,
  type AuthoringTaskClaim,
  type MySqlAuthoringTaskRepository,
} from '@h5cs/database';
import type { ConversationTurnGenerator } from './conversation-turn-processor.js';
import { generateDraftExpansion, generatePreviewReply } from './authoring-generation.js';
import {
  ModelCapacityError,
  ModelRuntimePausedError,
  ModelUnknownOutcomeError,
  type ModelPermit,
} from './model-runtime.js';
export type AuthoringTaskStore = Pick<
  MySqlAuthoringTaskRepository,
  | 'claimNext'
  | 'listRunnableMerchantHeads'
  | 'complete'
  | 'fail'
  | 'releaseBeforeDispatch'
  | 'reconcile'
>;
export class AuthoringTaskProcessor {
  constructor(
    private readonly store: AuthoringTaskStore,
    private readonly generator: ConversationTurnGenerator,
    private readonly owner: string,
  ) {}
  listRunnableMerchantHeads(now: Date, options?: { limit?: number; afterKey?: string }) {
    return this.store.listRunnableMerchantHeads(now, options);
  }
  async processOnce(
    signal: AbortSignal,
    merchantId: string,
    kind: 'draft.expand' | 'preview.reply',
    permit?: ModelPermit,
    onClaimed?: (claim: AuthoringTaskClaim | null) => void,
  ) {
    if (signal.aborted) return false;
    const claim = await this.store.claimNext(new Date(), this.owner, { merchantId, kind });
    onClaimed?.(claim);
    if (!claim) return false;
    if (signal.aborted) {
      await this.store.releaseBeforeDispatch(claim, new Date());
      return true;
    }
    const execution = AbortSignal.any([signal, AbortSignal.timeout(75000)]);
    let result: unknown;
    try {
      const context = {
        merchantId: claim.merchantId,
        operation: kind === 'draft.expand' ? ('writing' as const) : ('preview' as const),
        authoringClaim: claim,
        ...(permit ? { permit } : {}),
      };
      if (claim.payload.kind === 'draft.expand')
        result = await generateDraftExpansion(
          this.generator,
          claim.payload.input,
          execution,
          context,
        );
      else {
        if (!claim.facts) throw new AuthoringTaskError('INVALID_REQUEST');
        result = {
          answer: await generatePreviewReply(
            this.generator,
            { assistantName: claim.facts.assistantName, ...claim.facts.draft },
            claim.payload.input.question,
            execution,
            context,
          ),
        };
      }
      execution.throwIfAborted();
    } catch (e) {
      if (e instanceof ModelCapacityError || signal.aborted) {
        try {
          if (
            (await this.store.releaseBeforeDispatch(
              claim,
              new Date(),
              e instanceof ModelRuntimePausedError ? { reason: 'runtime_paused' } : undefined,
            )) === 'applied'
          )
            return true;
        } catch {}
      }
      const current = await this.store.reconcile(claim);
      if (current.state !== 'processing' || current.currentGeneration !== claim.claimGeneration)
        return true;
      await this.store.fail(
        claim,
        e instanceof ModelUnknownOutcomeError
          ? 'MODEL_RESULT_UNKNOWN'
          : e instanceof AuthoringTaskError
            ? e.code
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
