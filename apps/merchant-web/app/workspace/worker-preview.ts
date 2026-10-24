import { lstatSync, readFileSync } from 'node:fs';

import type { AssistantDraftConfig } from '@h5cs/domain';

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export class WorkerPreviewRateLimitError extends Error {
  public constructor() {
    super('Preview rate limit reached');
    this.name = 'WorkerPreviewRateLimitError';
  }
}

export function previewToken(environment: NodeJS.ProcessEnv): string | null {
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

export function previewWorkerUrl(environment: NodeJS.ProcessEnv): string | null {
  const value = environment['WORKER_READINESS_URL'];
  if (!value) return null;
  try {
    const url = new URL(value);
    const production = environment['NODE_ENV'] === 'production';
    if (
      url.protocol !== 'http:' ||
      url.pathname !== '/readyz' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      (production
        ? url.hostname !== 'worker' || url.port !== '3011'
        : !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '3011') ||
      url.href !== value
    ) {
      return null;
    }
    url.pathname = '/internal/preview';
    return url.href;
  } catch {
    return null;
  }
}

export async function requestWorkerPreview(
  input: {
    merchantId: string;
    assistantName: string;
    draft: AssistantDraftConfig;
    question: string;
  },
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (
    input.question.trim().length < 1 ||
    input.question.length > 2_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.question)
  ) {
    throw new Error('Preview question must contain 1 to 2000 characters');
  }
  const url = previewWorkerUrl(environment);
  const token = previewToken(environment);
  if (!url || !token) throw new Error('Preview is not configured');
  const response = await fetchImpl(url, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-h5cs-preview-token': token,
    },
    body: JSON.stringify({
      merchantId: input.merchantId,
      question: input.question,
      facts: { assistantName: input.assistantName, ...input.draft },
    }),
  });
  if (response.status === 429) throw new WorkerPreviewRateLimitError();
  if (
    response.status !== 200 ||
    !response.headers.get('content-type')?.includes('application/json')
  ) {
    throw new Error('Preview request failed');
  }
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new Error('Preview response is invalid');
  }
  const data = payload.data;
  if (
    typeof data !== 'object' ||
    data === null ||
    !('answer' in data) ||
    typeof data.answer !== 'string' ||
    data.answer.trim().length < 1 ||
    data.answer.length > 8_000
  ) {
    throw new Error('Preview answer is invalid');
  }
  return data.answer.trim();
}
