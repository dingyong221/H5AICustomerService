import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { ApiSuccessEnvelope } from '@h5cs/contracts';

import type { WorkerHealth } from './worker-health.js';

const writeJson = (
  response: import('node:http').ServerResponse,
  statusCode: number,
  body: unknown,
  requestId: string,
): void => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
  });
  response.end(JSON.stringify(body));
};

export const createHealthServer = (health: WorkerHealth): Server =>
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
