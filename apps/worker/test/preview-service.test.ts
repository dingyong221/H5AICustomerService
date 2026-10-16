import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ChatCompletionsGenerator } from '../src/chat-completions-generator.js';
import { PreviewError, PreviewService, createPreviewService } from '../src/preview-service.js';

const payload = {
  merchantId: 'aa'.repeat(16),
  question: '空调清洗多少钱？',
  facts: {
    assistantName: '测试客服',
    industry: '家政',
    businessScope: '空调清洗',
    materialsSummary: '挂机清洗\r\n柜机清洗',
    pricingSummary: '挂机 100 元/台',
    promotionSummary: '暂无优惠',
    insufficientInfoMessage: '请联系商家确认',
  },
};

function fixture() {
  const token = randomBytes(32).toString('base64url');
  const fetchImpl = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '挂机 100 元/台。' },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const generator = new ChatCompletionsGenerator(
    {
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-plus',
      apiKey: 'test_model_key_not_a_secret',
    },
    fetchImpl,
  );
  return { token, fetchImpl, service: new PreviewService(token, generator) };
}

describe('merchant draft preview', () => {
  it('requires the separate token and sends only draft facts to the configured model', async () => {
    const { token, service, fetchImpl } = fixture();
    expect(service.authorized(token)).toBe(true);
    expect(service.authorized(randomBytes(32).toString('base64url'))).toBe(false);
    expect(service.authorized(undefined)).toBe(false);
    await expect(service.reply(payload, new AbortController().signal)).resolves.toBe(
      '挂机 100 元/台。',
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content).toContain('商家测试草稿资料');
    expect(body.messages[1].content).toContain('挂机 100 元/台');
    expect(body.messages[2].content).toBe(payload.question);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(payload.merchantId);
  });

  it('rejects malformed facts before a provider request and limits each merchant separately', async () => {
    const { service, fetchImpl } = fixture();
    await expect(
      service.reply(
        { ...payload, facts: { ...payload.facts, pricingSummary: null } },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(PreviewError);
    expect(fetchImpl).not.toHaveBeenCalled();
    for (let index = 0; index < 5; index += 1)
      await service.reply(payload, new AbortController().signal);
    await expect(service.reply(payload, new AbortController().signal)).rejects.toMatchObject({
      statusCode: 429,
    });
    await expect(
      service.reply({ ...payload, merchantId: 'bb'.repeat(16) }, new AbortController().signal),
    ).resolves.toBe('挂机 100 元/台。');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('does not enable production preview using an inline token', () => {
    expect(
      createPreviewService({
        NODE_ENV: 'production',
        PREVIEW_AUTH_TOKEN: randomBytes(32).toString('base64url'),
      }),
    ).toBeNull();
  });

  it('accepts the existing 200-character assistant name limit and multiline questions', async () => {
    const { service } = fixture();
    const input = {
      ...payload,
      question: '提供哪些服务？\n多少钱？',
      facts: { ...payload.facts, assistantName: '名'.repeat(200) },
    };
    await expect(service.reply(input, new AbortController().signal)).resolves.toBe(
      '挂机 100 元/台。',
    );
    await expect(
      service.reply(
        { ...input, facts: { ...input.facts, assistantName: '名'.repeat(201) } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('passes the full 2000-character question and optional contact data as facts, never as transfer authority', async () => {
    const { service, fetchImpl } = fixture();
    const question = '问'.repeat(2_000);
    await service.reply(
      {
        ...payload,
        question,
        facts: { ...payload.facts, humanContact: '微信 shop_service，工作日9—18点' },
      },
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages[2].content).toBe(question);
    expect(body.messages[1].content).toContain('shop_service');
    expect(body.messages[0].content).toContain('不实时转接');
    await expect(
      service.reply({ ...payload, question: `${question}问` }, new AbortController().signal),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.reply(
        { ...payload, facts: { ...payload.facts, humanContact: '<a>联系</a>' } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
