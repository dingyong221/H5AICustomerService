import { describe, expect, it, vi } from 'vitest';
import {
  conversationPrivacyNotice,
  conversationPrivacyReply,
  correctPrivacyPromises,
} from '../src/conversation-privacy.js';
import { ChatCompletionsGenerator } from '../src/chat-completions-generator.js';
import { buildPreviewPrompt } from '../src/conversation-prompt.js';

describe('platform conversation retention', () => {
  it.each(['会保存我的聊天吗？', '帮我删除记录', '你会收集对话数据吗？'])(
    'uses the verified policy for %s',
    (question) => {
      expect(conversationPrivacyReply(question)).toBe(conversationPrivacyNotice);
    },
  );
  it('preserves product context and replaces inaccurate promises', () => {
    for (const promise of [
      '放心，我不会下单或保存信息。',
      '我不会保存聊天记录。',
      '已删除您的聊天记录。',
      '聊天记录已删除。',
    ]) {
      const answer = correctPrivacyPromises('您选了两只红杯。' + promise);
      expect(answer).toContain('两只红杯');
      expect(answer).toContain(conversationPrivacyNotice);
      expect(answer).not.toContain(promise);
    }
    expect(correctPrivacyPromises('每只86元，请保存订单号以便售后。')).toBe(
      '每只86元，请保存订单号以便售后。',
    );
  });
  it('answers privacy questions without a model call or a deletion claim', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const generator = new ChatCompletionsGenerator(
      {
        endpoint: 'https://example.test/chat/completions',
        model: 'test-only',
        apiKey: 'test-only-key',
      },
      fetchImpl,
    );
    const prompt = buildPreviewPrompt(
      {
        assistantName: '测试',
        industry: '零售',
        businessScope: '杯子',
        materialsSummary: '红杯',
        pricingSummary: '每只86元',
        promotionSummary: '无优惠',
        insufficientInfoMessage: '待确认',
      },
      '会保存我的聊天吗？',
    );
    expect(await generator.generate(prompt, AbortSignal.timeout(1000))).toBe(
      conversationPrivacyNotice,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
