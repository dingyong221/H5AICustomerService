import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ConversationTurnClaim } from '@h5cs/database';

import {
  ChatCompletionsGenerator,
  loadChatCompletionsConfig,
} from '../src/chat-completions-generator.js';
import { createConversationDispatch } from '../src/conversation-dispatch.js';
import type { ConversationPrompt } from '../src/conversation-prompt.js';

const modelEnvironment = {
  CONVERSATION_WORKER_ENABLED: 'true',
  MODEL_PROVIDER: 'chat_completions',
  MODEL_CHAT_COMPLETIONS_URL: 'https://model.example.com/v1/chat/completions',
  MODEL_API_KEY: 'test_api_key_not_a_secret',
  MODEL_NAME: 'approved-model',
  NODE_ENV: 'production',
};

const prompt: ConversationPrompt = {
  policy: '只按资料回答，不编造价格。',
  confirmedFacts: '{"pricing":"100 元/台"}',
  history: [
    { role: 'visitor', content: '清洗空调吗？' },
    { role: 'assistant', content: '提供挂机清洗。' },
  ],
  question: '多少钱？',
  insufficientInfoMessage: '请联系商家确认',
};

const response = (content: unknown, finishReason = 'stop'): Response =>
  new Response(
    JSON.stringify({
      object: 'chat.completion',
      choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

describe('configured Chat Completions generator', () => {
  it('requires an explicitly enabled non-mock HTTPS provider and a real secret', () => {
    expect(loadChatCompletionsConfig(modelEnvironment)).toMatchObject({ configured: true });
    expect(
      loadChatCompletionsConfig({ ...modelEnvironment, CONVERSATION_WORKER_ENABLED: 'false' })
        .configured,
    ).toBe(false);
    expect(
      loadChatCompletionsConfig({ ...modelEnvironment, MODEL_PROVIDER: 'mock' }).configured,
    ).toBe(false);
    expect(
      loadChatCompletionsConfig({ ...modelEnvironment, MODEL_API_KEY: 'replace-with-secret' })
        .configured,
    ).toBe(false);
    expect(
      loadChatCompletionsConfig({
        ...modelEnvironment,
        MODEL_CHAT_COMPLETIONS_URL: 'http://127.0.0.1:9000/v1/chat/completions',
      }).configured,
    ).toBe(false);
    expect(
      loadChatCompletionsConfig({
        ...modelEnvironment,
        MODEL_CHAT_COMPLETIONS_URL: 'https://user:pass@model.example.com/v1/chat/completions',
      }).configured,
    ).toBe(false);
  });

  it('accepts a bounded secret file and rejects ambiguous or unsafe key sources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'h5cs-model-key-'));
    const keyFile = join(directory, 'model-api-key');
    const key = 'test_file_key_not_a_secret';
    writeFileSync(keyFile, `${key}\n`);
    try {
      const fileEnvironment = {
        ...modelEnvironment,
        MODEL_API_KEY: '',
        MODEL_API_KEY_FILE: keyFile,
      };
      const result = loadChatCompletionsConfig(fileEnvironment);
      expect(result.configured).toBe(true);
      if (!result.configured) throw new Error(result.reason);
      expect(result.config.apiKey).toBe(key);
      expect(JSON.stringify(result.config)).not.toContain(key);
      expect(
        loadChatCompletionsConfig({ ...fileEnvironment, MODEL_API_KEY: 'another_real_secret_123' })
          .configured,
      ).toBe(false);
      expect(
        loadChatCompletionsConfig({ ...fileEnvironment, MODEL_API_KEY_FILE: 'relative/key' })
          .configured,
      ).toBe(false);
      writeFileSync(keyFile, 'too-short\n');
      expect(loadChatCompletionsConfig(fileEnvironment).configured).toBe(false);
    } finally {
      unlinkSync(keyFile);
      rmdirSync(directory);
    }
  });

  it('sends only pinned facts and session context through a bounded, non-streaming request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response('根据资料，100 元/台。'));
    const configured = loadChatCompletionsConfig(modelEnvironment);
    if (!configured.configured) throw new Error('test model configuration is invalid');
    expect(JSON.stringify(configured.config)).not.toContain(modelEnvironment.MODEL_API_KEY);
    const generator = new ChatCompletionsGenerator(configured.config, fetchImpl);
    expect(JSON.stringify(generator)).not.toContain(modelEnvironment.MODEL_API_KEY);
    await expect(generator.generate(prompt, new AbortController().signal)).resolves.toBe(
      '根据资料，100 元/台。',
    );
    const [url, options] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(modelEnvironment.MODEL_CHAT_COMPLETIONS_URL);
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    expect(options?.headers).toMatchObject({
      Authorization: `Bearer ${modelEnvironment.MODEL_API_KEY}`,
    });
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ model: 'approved-model', stream: false });
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      'system',
      'user',
      'user',
      'assistant',
      'user',
    ]);
    expect(JSON.stringify(body)).not.toContain(modelEnvironment.MODEL_API_KEY);
  });

  it.each([
    {
      productsAndServices: '清洗：79元/台，仅限壁挂机',
      pricingAndConditions: '清洗：89元/台，仅限壁挂机',
    },
    { promotionsAndSalesPolicy: '活动有效期至2000-01-01' },
  ])(
    'refuses clearly conflicting or expired pinned facts without calling a provider: %j',
    async (facts) => {
      const configured = loadChatCompletionsConfig(modelEnvironment);
      if (!configured.configured) throw new Error('test model configuration is invalid');
      const fetchImpl = vi.fn<typeof fetch>();
      const generator = new ChatCompletionsGenerator(configured.config, fetchImpl);
      const answer = await generator.generate(
        {
          ...prompt,
          confirmedFacts: JSON.stringify({ ...facts, humanContact: '请通过店铺客服窗口联系商家' }),
        },
        new AbortController().signal,
      );
      expect(answer).toContain('暂不能据此给出可靠报价或承诺');
      expect(answer).toContain('店铺客服窗口');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('allows different price conditions and supplies current trusted business time to the provider', async () => {
    const configured = loadChatCompletionsConfig(modelEnvironment);
    if (!configured.configured) throw new Error('test model configuration is invalid');
    const fetchImpl = vi.fn<typeof fetch>(async () => response('请按机型查看报价。'));
    const generator = new ChatCompletionsGenerator(configured.config, fetchImpl);
    await generator.generate(
      {
        ...prompt,
        confirmedFacts: JSON.stringify({
          productsAndServices: '清洗：79元/台，仅限壁挂机',
          pricingAndConditions: '清洗：99元/台，仅限柜机',
        }),
      },
      new AbortController().signal,
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain('当前可信业务时间：');
    expect(body.messages[0].content).toContain('Asia/Shanghai');
  });

  it('rejects incomplete, refused, oversized and non-JSON answers', async () => {
    const configured = loadChatCompletionsConfig(modelEnvironment);
    if (!configured.configured) throw new Error('test model configuration is invalid');
    const outputs = [
      response('截断', 'length'),
      new Response(
        JSON.stringify({
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '不能回答', refusal: 'refused' },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
      response('很长'.repeat(40_000)),
      new Response('<html>bad gateway</html>', { headers: { 'Content-Type': 'text/html' } }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => outputs.shift()!);
    const generator = new ChatCompletionsGenerator(configured.config, fetchImpl);
    for (let index = 0; index < 4; index += 1) {
      await expect(generator.generate(prompt, new AbortController().signal)).rejects.toThrow();
    }
  });

  it('wires a real job claim to the configured generator and durable completion', async () => {
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
      question: '多少钱？',
      context: [],
      facts: {
        displayName: '客服',
        industry: '家政',
        businessScope: '空调清洗',
        materialsSummary: '挂机清洗',
        pricingSummary: '100 元/台',
        promotionSummary: '暂无优惠',
        insufficientInfoMessage: '请联系商家确认',
      },
    };
    const complete = vi.fn(async () => 'applied' as const);
    const fail = vi.fn(async () => 'applied' as const);
    const directory = mkdtempSync(join(tmpdir(), 'h5cs-worker-ca-'));
    const caFile = join(directory, 'ca.pem');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nTEST-ONLY\n-----END CERTIFICATE-----\n');
    try {
      const dispatch = createConversationDispatch(
        {
          ...modelEnvironment,
          MYSQL_DATABASE_URL: 'mysql://test:test@mysql.internal/h5cs_test?ssl-mode=VERIFY_IDENTITY',
          MYSQL_TLS_CA_FILE: caFile,
        },
        {
          fetchImpl: vi.fn<typeof fetch>(async () => response('100 元/台。')),
          assertModelAccess: async () => undefined,
          attempts: {
            unknownRiskCount: async () => 0,
            markDispatch: async () => ({ attemptId: 'synthetic' }),
            recordOutcome: async () => undefined,
          },
          storeFactory: () => ({
            claimNext: async () => claim,
            complete,
            fail,
            listRunnableMerchantHeads: async () => [],
            releaseBeforeDispatch: async () => 'applied',
            reconcile: async () => ({
              state: 'completed',
              currentGeneration: claim.claimGeneration,
              modelOutcome: 'succeeded',
            }),
          }),
        },
      );
      if (!dispatch.configured) throw new Error(dispatch.reason);
      await expect(dispatch.processor.processOnce(new AbortController().signal)).resolves.toBe(
        true,
      );
      expect(complete).toHaveBeenCalledWith(claim, '100 元/台。', expect.any(Date));
      expect(fail).not.toHaveBeenCalled();
    } finally {
      unlinkSync(caFile);
      rmdirSync(directory);
    }
  });
});
