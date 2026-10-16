import { describe, expect, it } from 'vitest';

import { buildPreviewPrompt, type PreviewFacts } from '../src/conversation-prompt.js';

const facts: PreviewFacts = {
  assistantName: '保温杯测试客服',
  industry: '家居零售',
  businessScope: '保温杯售前售后',
  materialsSummary: 'M1 500ml。不支持代办退款，退换需商家确认。',
  pricingSummary: 'M1 每件89元；运费8元。',
  promotionSummary: '暂无优惠',
  insufficientInfoMessage: '当前资料无法确认，请联系商家核实。',
  humanContact: '微信 shop_service，工作日9:00—18:00。',
};

describe('complaint and human-help prompt boundary (offline policy tests, not model-quality scores)', () => {
  it('keeps confirmed promotion restrictions explicit even if an extra coupon is unknown', () => {
    const prompt = buildPreviewPrompt(
      { ...facts, promotionSummary: 'M1满2件减10元，2026-10-31截止，不可叠加。' },
      '能再叠20元券吗？',
    );
    expect(prompt.policy).toContain('已有明确限制必须直接说明');
    expect(prompt.policy).toContain('不能又说“无法判断是否可叠加”');
    expect(prompt.confirmedFacts).toContain('不可叠加');
  });
  it.each(['我要投诉，帮我找人工。', '已经申请退款了吗？', '你保证商家今天回复我吗？'])(
    'treats the merchant contact as data and prohibits fictitious processing: %s',
    (question) => {
      const prompt = buildPreviewPrompt(facts, question);
      expect(JSON.parse(prompt.confirmedFacts).humanContact).toBe(facts.humanContact);
      expect(prompt.question).toBe(question);
      expect(prompt.policy).toContain('此处不实时转接');
      expect(prompt.policy).toContain('不声称已交接、已受理或保证回复时间');
      expect(prompt.policy).toContain('条件未知时先询问最少的必要条件');
    },
  );

  it('keeps missing legacy contact empty instead of inventing a phone, transfer or service schedule', () => {
    const legacyFacts = { ...facts };
    Reflect.deleteProperty(legacyFacts, 'humanContact');
    const prompt = buildPreviewPrompt(legacyFacts, '我要找人工。');
    expect(JSON.parse(prompt.confirmedFacts).humanContact).toBe('');
    expect(prompt.confirmedFacts).not.toContain('shop_service');
    expect(prompt.policy).toContain('未提供时如实说明尚未提供');
  });
});
