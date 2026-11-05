import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceAccessError } from '@h5cs/database';
import {
  ChatCompletionsGenerator,
  loadChatCompletionsConfig,
} from '../src/chat-completions-generator.js';
import { PreviewService, createPreviewService } from '../src/preview-service.js';

const merchantId = 'ab'.repeat(16);
const context = { merchantId, operation: 'preview' };
const signal = () => new AbortController().signal;
const config = {
  endpoint: 'http://127.0.0.1:9020/chat/completions',
  model: 'local-fixture',
  apiKey: 'SYNTHETIC_NOT_A_SECRET',
};
const facts = {
  assistantName: '合成',
  industry: '合成',
  businessScope: '合成',
  materialsSummary: '合成',
  pricingSummary: '待确认',
  promotionSummary: '待确认',
  insufficientInfoMessage: '待确认',
};
const prompt = {
  policy: 'test',
  confirmedFacts: '{}',
  history: [],
  question: '商品价格？',
  insufficientInfoMessage: '待确认',
};

describe('marketplace supplier request boundary', () => {
  it('rejects external endpoints, production/file keys and non-fixture keys in local synthetic mode', () => {
    const env = {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      H5CS_MARKETPLACE_MODE: 'local-fixture',
      CONVERSATION_WORKER_ENABLED: 'true',
      MODEL_PROVIDER: 'chat_completions',
      MODEL_NAME: 'local-deterministic-fixture',
      MODEL_API_KEY: 'local-fixture-synthetic-only',
      MODEL_CHAT_COMPLETIONS_URL: config.endpoint,
    };
    expect(loadChatCompletionsConfig(env).configured).toBe(true);
    for (const patch of [
      {
        MODEL_CHAT_COMPLETIONS_URL:
          'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      },
      { NODE_ENV: 'production' },
      { MODEL_API_KEY: 'SYNTHETIC_NON_FIXTURE_KEY' },
      { MODEL_API_KEY_FILE: 'C:/not-read-by-local-fixture' },
    ])
      expect(loadChatCompletionsConfig({ ...env, ...patch }).configured).toBe(false);
  });
  it('checks eligibility for both deterministic and model replies, before quota or supplier activity', async () => {
    const reserve = vi.fn(async () => undefined),
      fetchImpl = vi.fn<typeof fetch>(),
      assertAccess = vi.fn(async () => {
        throw new MarketplaceAccessError('not_eligible');
      });
    const generator = new ChatCompletionsGenerator(config, fetchImpl, reserve, assertAccess);
    for (const question of ['转人工', '商品价格？'])
      await expect(
        generator.generate({ ...prompt, question }, signal(), context),
      ).rejects.toMatchObject({ code: 'not_eligible' });
    expect(assertAccess).toHaveBeenCalledTimes(2);
    expect(reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('requires a valid database in the runtime factory, including missing/malformed/unsafe targets', () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const env = {
        NODE_ENV: 'test',
        CONVERSATION_WORKER_ENABLED: 'true',
        MODEL_PROVIDER: 'chat_completions',
        MODEL_NAME: config.model,
        MODEL_API_KEY: config.apiKey,
        MODEL_CHAT_COMPLETIONS_URL: config.endpoint,
        PREVIEW_AUTH_TOKEN: randomBytes(32).toString('base64url'),
      };
      for (const database of [undefined, 'bad-url', 'mysql://test:test@remote/test'])
        expect(createPreviewService({ ...env, MYSQL_DATABASE_URL: database })).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not reserve or fetch for a deterministic contact reply even at zero quota', async () => {
    const reserve = vi.fn(async () => {
      throw new MarketplaceAccessError('quota_exhausted');
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const generator = new ChatCompletionsGenerator(config, fetchImpl, reserve);
    await expect(
      generator.generate({ ...prompt, question: '转人工' }, signal(), context),
    ).resolves.toContain('不实时转接');
    expect(reserve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('blocks preview/retest, writing and organization before supplier requests when reserve fails', async () => {
    const reserve = vi.fn(async () => {
      throw new MarketplaceAccessError('quota_exhausted');
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new PreviewService(
      randomBytes(32).toString('base64url'),
      new ChatCompletionsGenerator(config, fetchImpl, reserve),
    );
    await expect(
      service.reply({ merchantId, question: '合成价格', facts }, signal()),
    ).rejects.toMatchObject({ code: 'quota_exhausted' });
    await expect(
      service.organize({ merchantId, text: '合成材料' }, signal()),
    ).rejects.toMatchObject({ code: 'quota_exhausted' });
    await expect(
      service.write(
        { merchantId, field: 'pricingSummary', brief: '合成29元', currentText: '' },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'quota_exhausted' });
    expect(reserve.mock.calls).toHaveLength(3);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reserves each real new attempt, including supplier failures, without leaking budget context to the supplier', async () => {
    const reserve = vi.fn(async () => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({}, { status: 503 }));
    const generator = new ChatCompletionsGenerator(config, fetchImpl, reserve);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(generator.generate(prompt, signal(), context)).rejects.toThrow();
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain(merchantId);
    await expect(generator.generate(prompt, signal())).rejects.toThrow('budget context');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
