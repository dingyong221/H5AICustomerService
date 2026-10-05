import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseWritingInput, parseWritingResult } from '@h5cs/contracts';
import { requestWorkerWriting } from './worker-writing';
import { safeMerchantReturnPath } from '../account/merchant-return-path';
import { helpTopics, manualMarkdown, manualText, searchHelp } from '../help/manual';

const merchant = 'aa'.repeat(16);
const input = { field: 'businessScope' as const, brief: '卖家居用品', currentText: '' };
const result = {
  options: ['解答家居用品选购问题。', '提供家居用品咨询，具体商品需确认。'],
  reminders: ['请补充实际在售商品。'],
};
describe('writing and merchant help contracts', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('bounds inputs and rejects unknown fields and non-text values', () => {
    expect(parseWritingInput(input)).toEqual(input);
    for (const patch of [
      { field: '__proto__' },
      { brief: '' },
      { brief: 'x'.repeat(1001) },
      { brief: 'x\u0000' },
      { currentText: null },
      { currentText: 'x'.repeat(2001) },
    ])
      expect(parseWritingInput({ ...input, ...patch })).toBeNull();
  });
  it('bounds alternatives, normalizes single-line fields and rejects duplicate or malformed output', () => {
    expect(parseWritingResult(result, input.field)).toEqual(result);
    expect(
      parseWritingResult(
        { ...result, options: ['你好\n欢迎光临', '您好\t请提问'] },
        'welcomeMessage',
      )?.options,
    ).toEqual(['你好 欢迎光临', '您好 请提问']);
    for (const options of [[], ['only'], ['same', 'same'], ['x'.repeat(1001), 'y'], [null, 'y']])
      expect(parseWritingResult({ ...result, options }, input.field)).toBeNull();
  });
  it('keeps the provider token server-side and rejects throttled or malformed responses', async () => {
    const token = randomBytes(32).toString('base64url');
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      WORKER_READINESS_URL: 'http://127.0.0.1:3011/readyz',
      PREVIEW_AUTH_TOKEN: token,
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: result }));
    await expect(requestWorkerWriting(merchant, input, env, fetchImpl)).resolves.toEqual(result);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3011/internal/writing');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-h5cs-preview-token': token });
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).not.toContain(token);
    await expect(
      requestWorkerWriting(merchant, input, env, async () => Response.json({}, { status: 429 })),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      requestWorkerWriting(merchant, input, env, async () =>
        Response.json({ data: { options: ['bad'] } }),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('allows only this merchant help/writing paths and supports task-based manual search', () => {
    for (const section of ['help', 'writing'])
      expect(safeMerchantReturnPath(merchant, `/${merchant}/${section}`)).toBe(
        `/${merchant}/${section}`,
      );
    expect(safeMerchantReturnPath(merchant, `/${'bb'.repeat(16)}/help`)).toBeNull();
    expect(safeMerchantReturnPath(merchant, `/${merchant}/writing/generate`)).toBeNull();
    expect(searchHelp('帮我写').some((topic) => topic.id === 'writing')).toBe(true);
    expect(searchHelp('二维码').some((topic) => topic.id === 'share')).toBe(true);
    expect(searchHelp('zz-not-found')).toHaveLength(0);
    expect(searchHelp('')).toHaveLength(helpTopics.length);
    const manual = manualMarkdown();
    expect(manual).toContain('客服资料填写助手');
    expect(manual).toContain('不会自动保存或发布');
    expect(manual).not.toContain('sk-');
    expect(manualText()).toContain('商家 AI 客服使用手册');
    expect(manualText()).not.toMatch(/^#/mu);
  });
});
