import { timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { parseWritingInput, parseWritingResult, type WritingResult } from '@h5cs/contracts';
import { buildWritingPrompt, preservesProvidedNumbers } from './writing-prompt.js';

import {
  ChatCompletionsGenerator,
  loadChatCompletionsConfig,
} from './chat-completions-generator.js';
import { buildPreviewPrompt, type PreviewFacts } from './conversation-prompt.js';

export class PreviewError extends Error {
  public constructor(
    public readonly statusCode: 400 | 429,
    message: string,
  ) {
    super(message);
  }
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const idPattern = /^[0-9a-f]{32}$/u;
const controlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const fields: ReadonlyArray<readonly [keyof PreviewFacts, number]> = [
  ['assistantName', 200],
  ['industry', 128],
  ['businessScope', 2_000],
  ['materialsSummary', 4_000],
  ['pricingSummary', 4_000],
  ['promotionSummary', 4_000],
  ['insufficientInfoMessage', 500],
];

function readToken(environment: NodeJS.ProcessEnv): string | null {
  const inline = environment['PREVIEW_AUTH_TOKEN'];
  const path = environment['PREVIEW_AUTH_TOKEN_FILE'];
  if (inline && path) return null;
  if (environment['NODE_ENV'] !== 'production' && inline && tokenPattern.test(inline)) {
    return inline;
  }
  if (path !== '/run/secrets/h5cs-preview-token') return null;
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size < 43 || file.size > 45) return null;
    const token = readFileSync(path, 'utf8').replace(/\r?\n$/u, '');
    return tokenPattern.test(token) ? token : null;
  } catch {
    return null;
  }
}

function parsePayload(value: unknown): {
  merchantId: string;
  facts: PreviewFacts;
  question: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PreviewError(400, 'Invalid preview request');
  }
  const input = value as Record<string, unknown>;
  if (typeof input['merchantId'] !== 'string' || !idPattern.test(input['merchantId'])) {
    throw new PreviewError(400, 'Invalid preview request');
  }
  if (
    typeof input['question'] !== 'string' ||
    input['question'].trim().length < 1 ||
    input['question'].length > 2_000 ||
    controlCharacters.test(input['question'])
  ) {
    throw new PreviewError(400, 'Invalid preview question');
  }
  if (
    typeof input['facts'] !== 'object' ||
    input['facts'] === null ||
    Array.isArray(input['facts'])
  ) {
    throw new PreviewError(400, 'Invalid preview facts');
  }
  const candidate = input['facts'] as Record<string, unknown>;
  const humanContact = candidate['humanContact'];
  if (
    humanContact !== undefined &&
    (typeof humanContact !== 'string' ||
      humanContact.length > 500 ||
      /[\u0000-\u0009\u000b-\u001f\u007f<>]/u.test(humanContact))
  ) {
    throw new PreviewError(400, 'Invalid human contact instructions');
  }
  for (const [name, maximum] of fields) {
    const text = candidate[name];
    if (
      typeof text !== 'string' ||
      text.trim().length < 1 ||
      text.length > maximum ||
      controlCharacters.test(text)
    ) {
      throw new PreviewError(400, 'Invalid preview facts');
    }
  }
  return {
    merchantId: input['merchantId'],
    facts: candidate as PreviewFacts,
    question: input['question'].trim(),
  };
}

export class PreviewService {
  readonly #token: Buffer;
  readonly #generator: ChatCompletionsGenerator;
  readonly #requests = new Map<string, number[]>();
  readonly #writingBusy = new Set<string>();

  public constructor(token: string, generator: ChatCompletionsGenerator) {
    if (!tokenPattern.test(token)) throw new Error('Preview token is invalid');
    this.#token = Buffer.from(token, 'utf8');
    this.#generator = generator;
  }

  public authorized(value: unknown): boolean {
    if (typeof value !== 'string' || !tokenPattern.test(value)) return false;
    return timingSafeEqual(this.#token, Buffer.from(value, 'utf8'));
  }

  public async reply(payload: unknown, signal: AbortSignal): Promise<string> {
    const { merchantId, facts, question } = parsePayload(payload);
    this.limit(merchantId);
    return this.#generator.generate(buildPreviewPrompt(facts, question), signal);
  }

  private limit(merchantId: string): void {
    const now = Date.now();
    const recent = (this.#requests.get(merchantId) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= 5) throw new PreviewError(429, 'Preview rate limit reached');
    if (this.#requests.size > 1_000) {
      for (const [key, times] of this.#requests) {
        if (times.every((time) => now - time >= 60_000)) this.#requests.delete(key);
      }
    }
    recent.push(now);
    this.#requests.set(merchantId, recent);
  }

  public async write(payload: unknown, signal: AbortSignal): Promise<WritingResult> {
    const candidate =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const merchantId = candidate?.['merchantId'];
    const input = parseWritingInput(candidate);
    if (typeof merchantId !== 'string' || !idPattern.test(merchantId) || !input)
      throw new PreviewError(400, 'Invalid writing request');
    if (this.#writingBusy.has(merchantId) || this.#writingBusy.size >= 3)
      throw new PreviewError(429, 'Writing capacity reached');
    this.limit(merchantId);
    this.#writingBusy.add(merchantId);
    try {
      const answer = await this.#generator.generate(buildWritingPrompt(input), signal);
      const result = parseWritingResult(JSON.parse(answer), input.field);
      if (!result || !preservesProvidedNumbers(input, result))
        throw new Error('Invalid writing answer');
      const labeled =
        input.field === 'welcomeMessage'
          ? parseWritingResult(
              {
                ...result,
                options: result.options.map((text) =>
                  /\bAI\b|人工智能/iu.test(text) ? text : `您好，我是 AI 客服。${text}`,
                ),
              },
              input.field,
            )
          : result;
      if (!labeled) throw new Error('Invalid labeled writing answer');
      return labeled;
    } finally {
      this.#writingBusy.delete(merchantId);
    }
  }
}

export function createPreviewService(
  environment: NodeJS.ProcessEnv = process.env,
): PreviewService | null {
  const token = readToken(environment);
  const model = loadChatCompletionsConfig(environment);
  if (!token || !model.configured) return null;
  if (
    environment['NODE_ENV'] === 'production' &&
    new URL(model.config.endpoint).hostname !== 'dashscope.aliyuncs.com'
  ) {
    return null;
  }
  return new PreviewService(token, new ChatCompletionsGenerator(model.config));
}
