import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ChatCompletionsGenerator } from '../src/chat-completions-generator.js';
import { PreviewService } from '../src/preview-service.js';
import {
  buildWritingPrompt,
  groundFinancialWriting,
  preservesProvidedNumbers,
} from '../src/writing-prompt.js';
const input = {
  merchantId: 'aa'.repeat(16),
  field: 'pricingSummary' as const,
  brief: '毛巾 29 元每条，运费待确认',
  currentText: '',
};
const result = {
  options: ['毛巾售价 29 元/条，运费需商家确认。', '每条毛巾 29 元。具体运费请向商家确认。'],
  reminders: ['请补充运费规则。'],
};
function fixture(content = JSON.stringify(result)) {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    }),
  );
  return {
    fetchImpl,
    service: new PreviewService(
      randomBytes(32).toString('base64url'),
      new ChatCompletionsGenerator(
        {
          endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
          model: 'qwen-plus',
          apiKey: 'test_model_key_not_a_secret',
        },
        fetchImpl,
      ),
    ),
  };
}
describe('merchant writing service', () => {
  it('keeps the AI identity visible in generated welcome messages', async () => {
    const { service } = fixture(
      JSON.stringify({
        options: ['您好，欢迎咨询商品。', '欢迎光临，需要了解哪款商品？'],
        reminders: [],
      }),
    );
    const answer = await service.write(
      { ...input, field: 'welcomeMessage' },
      AbortSignal.timeout(1000),
    );
    expect(answer.options.every((text) => text.includes('AI 客服'))).toBe(true);
  });
  it('sends only selected text, not merchant identifiers, and instructs against invented facts', async () => {
    const { service, fetchImpl } = fixture();
    await expect(service.write(input, AbortSignal.timeout(1000))).resolves.toEqual(
      groundFinancialWriting(input, result),
    );
    const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
    expect(body).toContain('绝不添加商家未提供');
    expect(body).toContain(input.brief);
    expect(body).not.toContain(input.merchantId);
    expect(buildWritingPrompt(input).policy).toContain('价格与优惠须保留适用条件');
  });
  it('rejects malformed outputs and replaces unsupported financial copy with provided text', async () => {
    for (const content of ['not JSON', '{"options":["only"],"reminders":[]}']) {
      await expect(
        fixture(content).service.write(input, AbortSignal.timeout(1000)),
      ).rejects.toThrow();
    }
    const corrected = await fixture(
      JSON.stringify({
        options: ['29元不含税费和运费', '优惠价一元，包邮，以订单结算为准'],
        reminders: ['默认所有规格统一价格'],
      }),
    ).service.write(input, AbortSignal.timeout(1000));
    expect(corrected).toEqual(groundFinancialWriting(input, result));
    expect(corrected.options.every((text) => text.includes(input.brief))).toBe(true);
    expect(corrected.options.join('')).not.toMatch(/含税|包邮|订单结算|一元|19/u);
    expect(preservesProvidedNumbers(input, result)).toBe(true);
    expect(
      preservesProvidedNumbers(input, { ...result, options: ['29 元，包邮满 100 元', '29 元'] }),
    ).toBe(false);
  });
  it('shares the bounded merchant quota and rejects invalid payload before provider invocation', async () => {
    const { service, fetchImpl } = fixture();
    await expect(
      service.write({ ...input, field: 'unknown' }, AbortSignal.timeout(1000)),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) await service.write(input, AbortSignal.timeout(1000));
    await expect(service.write(input, AbortSignal.timeout(1000))).rejects.toMatchObject({
      statusCode: 429,
    });
    await expect(
      service.write({ ...input, merchantId: 'bb'.repeat(16) }, AbortSignal.timeout(1000)),
    ).resolves.toEqual(groundFinancialWriting(input, result));
  });
  it.each(['pricingSummary', 'promotionSummary'] as const)(
    'preserves explicitly supplied taxes, shipping and conditions without inheriting old prices: %s',
    async (field) => {
      const provided = {
        ...input,
        field,
        brief: '杯子每只86元，含税；运费另计，不同规格按商家核实报价；优惠截至12月1日。',
        currentText: '旧价99元，原活动包邮。',
      };
      const answer = await fixture(
        JSON.stringify({
          options: ['每只86元，不含税，所有规格统一价。', '每只一元，永久包邮。'],
          reminders: [],
        }),
      ).service.write(provided, AbortSignal.timeout(1000));
      for (const text of answer.options) {
        expect(text).toContain(provided.brief);
        expect(text).not.toMatch(/99元|永久|不含税|统一价|一元/u);
      }
      expect(answer.reminders.join('')).toContain('对照当前原文');
    },
  );
  it('accepts a maximum-length financial brief without truncating the source', async () => {
    const brief = '价'.repeat(990) + '每只86元含税。';
    const answer = await fixture().service.write({ ...input, brief }, AbortSignal.timeout(1000));
    expect(answer.options).toHaveLength(3);
    expect(answer.options.every((text) => text.includes(brief))).toBe(true);
  });
});
