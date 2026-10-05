import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ChatCompletionsGenerator } from '../src/chat-completions-generator.js';
import { PreviewService } from '../src/preview-service.js';
import { buildWritingPrompt, preservesProvidedNumbers } from '../src/writing-prompt.js';
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
  it('sends only selected text, not merchant identifiers, and instructs against invented facts', async () => {
    const { service, fetchImpl } = fixture();
    await expect(service.write(input, AbortSignal.timeout(1000))).resolves.toEqual(result);
    const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
    expect(body).toContain('绝不添加商家未提供');
    expect(body).toContain(input.brief);
    expect(body).not.toContain(input.merchantId);
    expect(buildWritingPrompt(input).policy).toContain('价格与优惠须保留适用条件');
  });
  it('rejects malformed or out-of-bound outputs and unsupported financial numbers', async () => {
    for (const content of [
      'not JSON',
      '{"options":["only"],"reminders":[]}',
      JSON.stringify({ ...result, options: ['29 元', '19 元优惠'] }),
    ]) {
      await expect(
        fixture(content).service.write(input, AbortSignal.timeout(1000)),
      ).rejects.toThrow();
    }
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
    ).resolves.toEqual(result);
  });
});
