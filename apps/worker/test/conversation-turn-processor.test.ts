import { describe, expect, it, vi } from 'vitest';

import type { ConversationTurnClaim } from '@h5cs/database';

import type { ConversationPrompt } from '../src/conversation-prompt.js';
import { ConversationTurnProcessor } from '../src/conversation-turn-processor.js';
import { ModelUnknownOutcomeError } from '../src/model-runtime.js';

const claim: ConversationTurnClaim = {
  jobId: '11'.repeat(16),
  leaseOwner: 'worker_test_01',
  claimGeneration: '1',
  leaseUntil: new Date(Date.now() + 120_000),
  payloadVersion: 0,
  merchantId: '22'.repeat(16),
  assistantId: '33'.repeat(16),
  sessionId: '44'.repeat(16),
  releaseId: '55'.repeat(16),
  turnId: '66'.repeat(16),
  visitorMessageId: '77'.repeat(16),
  question: '空调清洗多少钱？',
  facts: {
    displayName: '客服',
    industry: '家庭服务',
    businessScope: '空调清洗',
    materialsSummary: '提供挂机清洗',
    pricingSummary: '100 元/台',
    promotionSummary: '暂无优惠',
    insufficientInfoMessage: '请联系商家确认',
  },
  context: [],
};
const recovery = {
  listRunnableMerchantHeads: async () => [],
  releaseBeforeDispatch: async () => 'applied' as const,
  reconcile: async () => ({
    state: 'completed' as const,
    currentGeneration: claim.claimGeneration,
    modelOutcome: 'succeeded' as const,
  }),
};

describe('conversation turn processor', () => {
  it('commits a generated answer against the claimed pinned-release job', async () => {
    const claimNext = vi.fn(async () => claim);
    const complete = vi.fn(async () => 'applied' as const);
    const fail = vi.fn(async () => 'applied' as const);
    const generate = vi.fn(
      async (_prompt: ConversationPrompt, _signal: AbortSignal) =>
        '根据已确认资料，挂机清洗为 100 元/台。',
    );
    const processor = new ConversationTurnProcessor(
      { ...recovery, claimNext, complete, fail },
      { generate },
      'worker_test_01',
    );
    await expect(processor.processOnce(new AbortController().signal)).resolves.toBe(true);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        question: '空调清洗多少钱？',
        confirmedFacts: expect.stringContaining('100 元/台'),
      }),
      expect.any(AbortSignal),
      { merchantId: claim.merchantId, operation: 'consumer', claim },
    );
    expect(JSON.stringify(generate.mock.calls[0]?.[0])).not.toContain(claim.sessionId);
    expect(complete).toHaveBeenCalledWith(
      claim,
      '根据已确认资料，挂机清洗为 100 元/台。',
      expect.any(Date),
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it('records a terminal error rather than fabricating a reply when generation fails', async () => {
    const complete = vi.fn(async () => 'applied' as const);
    const fail = vi.fn(async () => 'applied' as const);
    const processor = new ConversationTurnProcessor(
      { ...recovery, claimNext: async () => claim, complete, fail },
      {
        generate: async () => {
          throw new Error('provider secret must not appear in logs');
        },
      },
      'worker_test_01',
    );
    await expect(processor.processOnce(new AbortController().signal)).resolves.toBe(true);
    expect(fail).toHaveBeenCalledWith(claim, 'MODEL_UNAVAILABLE', expect.any(Date));
    expect(complete).not.toHaveBeenCalled();
  });

  it('reconciles a lost completion response without failing an already committed answer', async () => {
    const fail = vi.fn(async () => 'applied' as const);
    const reconcile = vi.fn(recovery.reconcile);
    const processor = new ConversationTurnProcessor(
      {
        ...recovery,
        claimNext: async () => claim,
        complete: async () => {
          throw new Error('connection lost after commit');
        },
        fail,
        reconcile,
      },
      { generate: async () => '100 元/台。' },
      'worker_test_01',
    );
    await processor.processOnce(new AbortController().signal);
    expect(reconcile).toHaveBeenCalledWith(claim);
    expect(fail).not.toHaveBeenCalled();
  });

  it('drops a late completion after a newer generation claimed the lease', async () => {
    const fail = vi.fn(async () => 'stale' as const);
    const complete = vi.fn(async () => 'stale' as const);
    const processor = new ConversationTurnProcessor(
      { ...recovery, claimNext: async () => claim, complete, fail },
      { generate: async () => 'late answer' },
      'worker_test_01',
    );
    await processor.processOnce(new AbortController().signal);
    expect(complete).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', '1', 'succeeded', undefined],
    ['processing', '2', 'succeeded', undefined],
    ['cancelled', '1', 'unknown', undefined],
    ['processing', '1', 'unknown', 'MODEL_RESULT_UNKNOWN'],
    ['processing', '1', 'dispatched', 'MODEL_RESULT_UNKNOWN'],
    ['processing', '1', 'succeeded', 'TURN_FINALIZATION_FAILED'],
  ] as const)(
    'reconciles finalization failure at %s generation %s outcome %s before any further write',
    async (state, currentGeneration, modelOutcome, failureCode) => {
      const events: string[] = [];
      const fail = vi.fn(async () => {
        events.push('fail');
        return 'applied' as const;
      });
      const generate = vi.fn(async () => 'generated once');
      const processor = new ConversationTurnProcessor(
        {
          ...recovery,
          claimNext: async () => claim,
          complete: async () => {
            events.push('complete');
            throw new Error('commit response lost');
          },
          reconcile: async () => {
            events.push('reconcile');
            return { state, currentGeneration, modelOutcome };
          },
          fail,
        },
        { generate },
        'worker_test_01',
      );
      await expect(processor.processOnce(new AbortController().signal)).resolves.toBe(true);
      expect(generate).toHaveBeenCalledOnce();
      expect(events).toEqual(
        failureCode ? ['complete', 'reconcile', 'fail'] : ['complete', 'reconcile'],
      );
      if (failureCode) expect(fail).toHaveBeenCalledWith(claim, failureCode, expect.any(Date));
      else expect(fail).not.toHaveBeenCalled();
    },
  );

  it.each(['completed', 'processing'] as const)(
    'does not overwrite %s or a newer claim when supplier outcome is uncertain',
    async (state) => {
      const fail = vi.fn(async () => 'applied' as const);
      const complete = vi.fn(async () => 'applied' as const);
      const processor = new ConversationTurnProcessor(
        {
          ...recovery,
          claimNext: async () => claim,
          complete,
          fail,
          reconcile: async () => ({
            state,
            currentGeneration: state === 'processing' ? '2' : '1',
            modelOutcome: 'dispatched',
          }),
        },
        {
          generate: async () => {
            throw new ModelUnknownOutcomeError('reservation requires reconciliation');
          },
        },
        'worker_test_01',
      );
      await expect(processor.processOnce(new AbortController().signal)).resolves.toBe(true);
      expect(fail).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it('leaves uncertain finalization unchanged when reconciliation itself is unavailable', async () => {
    const fail = vi.fn(async () => 'applied' as const);
    const processor = new ConversationTurnProcessor(
      {
        ...recovery,
        claimNext: async () => claim,
        fail,
        complete: async () => {
          throw new Error('commit response lost');
        },
        reconcile: async () => {
          throw new Error('database unavailable');
        },
      },
      { generate: async () => 'generated once' },
      'worker_test_01',
    );
    await expect(processor.processOnce(new AbortController().signal)).rejects.toThrow(
      'database unavailable',
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it('releases a claim interrupted before dispatch and records unknown supplier calls for manual recovery', async () => {
    const abort = new AbortController();
    const fail = vi.fn(async () => 'applied' as const);
    const releaseBeforeDispatch = vi.fn(recovery.releaseBeforeDispatch);
    const generate = vi.fn(async () => 'unused');
    const processor = new ConversationTurnProcessor(
      {
        ...recovery,
        claimNext: async () => {
          abort.abort();
          return claim;
        },
        complete: async () => 'applied',
        fail,
        releaseBeforeDispatch,
      },
      { generate },
      'worker_test_01',
    );
    await processor.processOnce(abort.signal);
    expect(generate).not.toHaveBeenCalled();
    expect(releaseBeforeDispatch).toHaveBeenCalledWith(claim, expect.any(Date));
    expect(fail).not.toHaveBeenCalled();
    const unknown = new ConversationTurnProcessor(
      {
        ...recovery,
        claimNext: async () => claim,
        complete: async () => 'applied',
        fail,
        reconcile: async () => ({
          state: 'processing',
          currentGeneration: claim.claimGeneration,
          modelOutcome: 'unknown',
        }),
      },
      {
        generate: async () => {
          throw new ModelUnknownOutcomeError('unconfirmed');
        },
      },
      'worker_test_01',
    );
    await unknown.processOnce(new AbortController().signal);
    expect(fail).toHaveBeenCalledWith(claim, 'MODEL_RESULT_UNKNOWN', expect.any(Date));
  });
});
