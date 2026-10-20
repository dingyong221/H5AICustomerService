import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { ApiSuccessEnvelope } from '@h5cs/contracts';

import type { WorkerHealth } from './worker-health.js';
import { PreviewError, type PreviewService } from './preview-service.js';

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

const readPreviewBody = async (request: import('node:http').IncomingMessage): Promise<unknown> => {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new PreviewError(400, 'Invalid content type');
  }
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
};

async function handlePreview(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  service: PreviewService | null,
  requestId: string,
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
    const payload = await readPreviewBody(request);
    const data =
      request.url === '/internal/knowledge'
        ? await service.organize(payload, AbortSignal.timeout(20_000))
        : request.url === '/internal/writing'
          ? await service.write(payload, AbortSignal.timeout(20_000))
          : { answer: await service.reply(payload, AbortSignal.timeout(20_000)) };
    writeJson(response, 200, { data, request_id: requestId }, requestId);
  } catch (error) {
    const status = error instanceof PreviewError ? error.statusCode : 503;
    writeJson(
      response,
      status,
      {
        error: {
          code:
            status === 429 ? 'RATE_LIMITED' : status === 400 ? 'INVALID_REQUEST' : 'UNAVAILABLE',
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
      void handlePreview(request, response, preview, requestId);
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
