import { MarketplaceAccessError } from '@h5cs/database';
import type { ConversationTurnClaim } from '@h5cs/database';

import { buildConversationPrompt, type ConversationPrompt } from './conversation-prompt.js';

export type ConversationTurnStore = Readonly<{
  claimNext: (now: Date, leaseOwner: string) => Promise<ConversationTurnClaim | null>;
  complete: (claim: ConversationTurnClaim, answer: string, now: Date) => Promise<void>;
  fail: (claim: ConversationTurnClaim, errorCode: string, now: Date) => Promise<void>;
}>;

export type ConversationTurnGenerator = Readonly<{
  generate: (
    prompt: ConversationPrompt,
    signal: AbortSignal,
    context?: { merchantId: string; operation: string },
  ) => Promise<string>;
}>;

export class ConversationTurnProcessor {
  public constructor(
    private readonly store: ConversationTurnStore,
    private readonly generator: ConversationTurnGenerator,
    private readonly leaseOwner: string,
  ) {}

  public async processOnce(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const claim = await this.store.claimNext(new Date(), this.leaseOwner);
    if (!claim) return false;
    let answer: string;
    const turnSignal = AbortSignal.any([signal, AbortSignal.timeout(75_000)]);
    try {
      answer = await this.generator.generate(buildConversationPrompt(claim), turnSignal, {
        merchantId: claim.merchantId,
        operation: 'consumer',
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
      await this.store.fail(
        claim,
        error instanceof MarketplaceAccessError
          ? error.code === 'quota_exhausted'
            ? 'MARKETPLACE_QUOTA_EXHAUSTED'
            : 'MARKETPLACE_NOT_ELIGIBLE'
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
      await this.store.fail(claim, 'TURN_FINALIZATION_FAILED', new Date());
    }
    return true;
  }
}
