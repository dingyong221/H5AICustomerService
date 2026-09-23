import { describe, expect, it, vi } from 'vitest';

import type { ConversationTurnClaim } from '@h5cs/database';

import type { ConversationPrompt } from '../src/conversation-prompt.js';
import { ConversationTurnProcessor } from '../src/conversation-turn-processor.js';

const claim: ConversationTurnClaim = {
  jobId: '11'.repeat(16), leaseOwner: 'worker_test_01',
  merchantId: '22'.repeat(16), assistantId: '33'.repeat(16),
  sessionId: '44'.repeat(16), releaseId: '55'.repeat(16),
  turnId: '66'.repeat(16), visitorMessageId: '77'.repeat(16),
  question: '空调清洗多少钱？',
  facts: {
    displayName: '客服', industry: '家庭服务', businessScope: '空调清洗',
    materialsSummary: '提供挂机清洗', pricingSummary: '100 元/台',
    promotionSummary: '暂无优惠', insufficientInfoMessage: '请联系商家确认',
  },
  context: [],
};

describe('conversation turn processor', () => {
  it('commits a generated answer against the claimed pinned-release job', async () => {
    const claimNext = vi.fn(async () => claim);
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const generate = vi.fn(async (_prompt: ConversationPrompt, _signal: AbortSignal) =>
      '根据已确认资料，挂机清洗为 100 元/台。');
    const processor = new ConversationTurnProcessor(
      { claimNext, complete, fail }, { generate }, 'worker_test_01',
    );
    await expect(processor.processOnce(new AbortController().signal)).resolves.toBe(true);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      question: '空调清洗多少钱？',
      confirmedFacts: expect.stringContaining('100 元/台'),
    }), expect.any(AbortSignal));
    expect(JSON.stringify(generate.mock.calls[0]?.[0])).not.toContain(claim.sessionId);
    expect(complete).toHaveBeenCalledWith(claim, '根据已确认资料，挂机清洗为 100 元/台。', expect.any(Date));
    expect(fail).not.toHaveBeenCalled();
  });

  it('records a terminal error rather than fabricating a reply when generation fails', async () => {
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const processor = new ConversationTurnProcessor(
      { claimNext: async () => claim, complete, fail },
      { generate: async () => { throw new Error('provider secret must not appear in logs'); } },
      'worker_test_01',
    );
    await expect(processor.processOnce(new AbortController().signal)).resolves.toBe(true);
    expect(fail).toHaveBeenCalledWith(claim, 'MODEL_UNAVAILABLE', expect.any(Date));
    expect(complete).not.toHaveBeenCalled();
  });
});
