import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import { requestIdSchema } from '@h5cs/contracts';

import type { MutableRequestWithId, ResponseLike } from './http-types.js';

const firstHeaderValue = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : value?.[0];

export const resolveRequestId = (candidate: string | undefined): string => {
  const parsed = requestIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : `req_${randomUUID()}`;
};

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  public use(request: MutableRequestWithId, response: ResponseLike, next: () => void): void {
    const requestId = resolveRequestId(firstHeaderValue(request.headers['x-request-id']));
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    next();
  }
}
