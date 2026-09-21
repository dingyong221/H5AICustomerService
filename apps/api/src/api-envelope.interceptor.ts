import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { ApiSuccessEnvelope } from '@h5cs/contracts';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import type { RequestWithId } from './http-types.js';

@Injectable()
export class ApiEnvelopeInterceptor implements NestInterceptor {
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithId>();

    return next.handle().pipe(
      map((data: unknown): ApiSuccessEnvelope<unknown> => ({
        data,
        request_id: request.requestId ?? 'request_id_missing',
      })),
    );
  }
}
