import { MarketplaceAccessError } from '@h5cs/database';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { ApiSuccessEnvelope } from '@h5cs/contracts';

import type { WorkerHealth } from './worker-health.js';
import { PreviewError, type PreviewService } from './preview-service.js';
import { ModelCapacityError } from './model-runtime.js';
import { abortable } from './abortable.js';

const writeJson = (
  response: import('node:http').ServerResponse,
  statusCode: number,
  body: unknown,
  requestId: string,
): void => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
  });
  response.end(JSON.stringify(body));
};

const readPreviewBody = async (
  request: import('node:http').IncomingMessage,
  signal: AbortSignal,
): Promise<unknown> => {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new PreviewError(400, 'Invalid content type');
  }
  signal.throwIfAborted();
  const abort = (): void => {
    request.destroy();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.byteLength;
      if (length > 131_072) throw new PreviewError(400, 'Preview request is too large');
      chunks.push(bytes);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as unknown;
    } catch {
      throw new PreviewError(400, 'Invalid preview request');
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

async function handlePreview(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  service: PreviewService | null,
  requestId: string,
  timeoutMs: number,
): Promise<void> {
  if (!service) {
    writeJson(response, 503, { error: { code: 'UNAVAILABLE' }, request_id: requestId }, requestId);
    return;
  }
  if (!service.authorized(request.headers['x-h5cs-preview-token'])) {
    writeJson(response, 404, { error: { code: 'NOT_FOUND' }, request_id: requestId }, requestId);
    return;
  }
  try {
    const disconnected = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) disconnected.abort();
    };
    response.once('close', onClose);
    // Keep this synchronous budget inside the merchant server's 25s upstream
    // deadline. It includes waiting for shared capacity, before any reservation.
    const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      const payload = await abortable(readPreviewBody(request, signal), signal);
      signal.throwIfAborted();
      const operation: Promise<unknown> =
        request.url === '/internal/knowledge'
          ? service.organize(payload, signal)
          : request.url === '/internal/writing'
            ? service.write(payload, signal)
            : service.reply(payload, signal).then((answer) => ({ answer }));
      const data = await abortable(operation, signal);
      writeJson(response, 200, { data, request_id: requestId }, requestId);
    } finally {
      response.off('close', onClose);
    }
  } catch (error) {
    const marketCode =
      error instanceof MarketplaceAccessError
        ? error.code === 'quota_exhausted'
          ? 'MARKETPLACE_QUOTA_EXHAUSTED'
          : 'MARKETPLACE_NOT_ELIGIBLE'
        : null;
    const status = marketCode
      ? marketCode === 'MARKETPLACE_QUOTA_EXHAUSTED'
        ? 429
        : 403
      : error instanceof ModelCapacityError
        ? 429
        : error instanceof PreviewError
          ? error.statusCode
          : 503;
    writeJson(
      response,
      status,
      {
        error: {
          code:
            marketCode ??
            (status === 429 ? 'RATE_LIMITED' : status === 400 ? 'INVALID_REQUEST' : 'UNAVAILABLE'),
        },
        request_id: requestId,
      },
      requestId,
    );
  }
}

export const createHealthServer = (
  health: WorkerHealth,
  preview: PreviewService | null = null,
  timeoutMs = 20_000,
): Server =>
  createServer((request, response) => {
    const candidate = request.headers['x-request-id'];
    const requestId =
      typeof candidate === 'string' && /^[A-Za-z0-9._:-]{8,128}$/u.test(candidate)
        ? candidate
        : `req_${randomUUID()}`;

    if (request.method === 'GET' && request.url === '/livez') {
      const data = health.liveness();
      const body: ApiSuccessEnvelope<typeof data> = { data, request_id: requestId };
      writeJson(response, 200, body, requestId);
      return;
    }

    if (request.method === 'GET' && request.url === '/readyz') {
      const data = health.readiness();
      const body: ApiSuccessEnvelope<typeof data> = { data, request_id: requestId };
      writeJson(response, data.status === 'ready' ? 200 : 503, body, requestId);
      return;
    }

    if (
      request.method === 'POST' &&
      ['/internal/preview', '/internal/writing', '/internal/knowledge'].includes(request.url ?? '')
    ) {
      void handlePreview(request, response, preview, requestId, timeoutMs);
      return;
    }

    writeJson(
      response,
      404,
      {
        error: { code: 'NOT_FOUND', message: 'Not found', retryable: false },
        request_id: requestId,
      },
      requestId,
    );
  });
