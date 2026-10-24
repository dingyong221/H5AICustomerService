import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  previewWorkerUrl,
  requestWorkerPreview,
  WorkerPreviewRateLimitError,
} from './worker-preview';

describe('merchant preview Worker boundary', () => {
  it('accepts only the exact configured internal endpoint in production', () => {
    const environment = {
      NODE_ENV: 'production',
      WORKER_READINESS_URL: 'http://worker:3011/readyz',
    } satisfies NodeJS.ProcessEnv;
    expect(previewWorkerUrl(environment)).toBe('http://worker:3011/internal/preview');
    for (const url of [
      'http://127.0.0.1:3011/readyz',
      'https://evil.example/readyz',
      'http://worker:3011/readyz?x=1',
      'http://worker:3012/readyz',
    ]) {
      expect(previewWorkerUrl({ ...environment, WORKER_READINESS_URL: url })).toBeNull();
    }
  });

  it('forwards the draft with the internal token and rejects failed or malformed answers', async () => {
    const token = randomBytes(32).toString('base64url');
    const environment = {
      NODE_ENV: 'test',
      WORKER_READINESS_URL: 'http://127.0.0.1:3011/readyz',
      PREVIEW_AUTH_TOKEN: token,
    } satisfies NodeJS.ProcessEnv;
    const input = {
      merchantId: 'aa'.repeat(16),
      assistantName: '测试客服',
      question: '多少钱？',
      draft: {
        industry: '家政',
        businessScope: '清洗',
        materialsSummary: '挂机',
        pricingSummary: '100 元',
        promotionSummary: '无优惠',
        welcomeMessage: '您好',
        insufficientInfoMessage: '请确认',
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: { answer: '100 元。' } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(requestWorkerPreview(input, environment, fetchImpl)).resolves.toBe('100 元。');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-h5cs-preview-token': token });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      merchantId: input.merchantId,
      facts: { pricingSummary: '100 元' },
    });
    for (const result of [
      new Response('{}', { status: 503 }),
      new Response(JSON.stringify({ data: { answer: '' } }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ]) {
      await expect(
        requestWorkerPreview(
          input,
          environment,
          vi.fn<typeof fetch>(async () => result),
        ),
      ).rejects.toThrow();
    }
    const limitedFetch = vi.fn<typeof fetch>(
      async () => new Response('upstream detail', { status: 429 }),
    );
    await expect(requestWorkerPreview(input, environment, limitedFetch)).rejects.toBeInstanceOf(
      WorkerPreviewRateLimitError,
    );
    expect(limitedFetch).toHaveBeenCalledOnce();
  });

  it('forwards the full 2000-character question and rejects overflow before any request', async () => {
    const environment = {
      NODE_ENV: 'test',
      WORKER_READINESS_URL: 'http://127.0.0.1:3011/readyz',
      PREVIEW_AUTH_TOKEN: randomBytes(32).toString('base64url'),
    } satisfies NodeJS.ProcessEnv;
    const input = {
      merchantId: 'aa'.repeat(16),
      assistantName: '测试客服',
      question: '问'.repeat(2_000),
      draft: {
        industry: '零售',
        businessScope: '保温杯',
        materialsSummary: 'M1',
        pricingSummary: '89元/件',
        promotionSummary: '暂无优惠',
        welcomeMessage: '您好',
        insufficientInfoMessage: '请确认',
        humanContact: '微信 shop_service，工作日9—18点',
      },
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: { answer: '需要确认。' } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await requestWorkerPreview(input, environment, fetchImpl);
    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(payload.question).toBe(input.question);
    expect(payload.facts.humanContact).toBe(input.draft.humanContact);
    await expect(
      requestWorkerPreview({ ...input, question: `${input.question}问` }, environment, fetchImpl),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
