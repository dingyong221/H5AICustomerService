import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorEnvelope, ErrorCode } from '@h5cs/contracts';
import { errorCodeSchema } from '@h5cs/contracts';

import type { RequestWithId, ResponseLike } from './http-types.js';

const statusToErrorCode = (status: number): ErrorCode => {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_ERROR';
  }
};

const safeMessage = (exception: unknown, status: number): string => {
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    if (typeof response === 'object' && response !== null && 'message' in response) {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }

  return status >= 500 ? 'Service unavailable' : 'Request failed';
};

const safeErrorMetadata = (
  exception: unknown,
  status: number,
): Readonly<{ code: ErrorCode; retryable: boolean }> => {
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    if (typeof response === 'object' && response !== null) {
      const candidate = response as { code?: unknown; retryable?: unknown };
      const parsedCode = errorCodeSchema.safeParse(candidate.code);
      if (parsedCode.success) {
        return {
          code: parsedCode.data,
          retryable:
            typeof candidate.retryable === 'boolean'
              ? candidate.retryable
              : status === HttpStatus.TOO_MANY_REQUESTS || status >= 500,
        };
      }
    }
  }

  return {
    code: statusToErrorCode(status),
    retryable: status === HttpStatus.TOO_MANY_REQUESTS || status >= 500,
  };
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<ResponseLike>();
    const request = http.getRequest<RequestWithId>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const metadata = safeErrorMetadata(exception, status);

    const body: ApiErrorEnvelope = {
      error: {
        code: metadata.code,
        message: safeMessage(exception, status),
        retryable: metadata.retryable,
      },
      request_id: request.requestId ?? 'request_id_missing',
    };

    response.status(status).json(body);
  }
}
