import type { ArgumentsHost } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { livenessDataSchema, platformInfoDataSchema, readinessDataSchema } from '@h5cs/contracts';

import { AppController } from '../src/app.controller.js';
import { ApiExceptionFilter } from '../src/api-exception.filter.js';
import { HealthService } from '../src/health.service.js';
import type { ResponseLike } from '../src/http-types.js';
import { resolveRequestId } from '../src/request-id.js';

describe('API foundation', () => {
  it('returns contract-valid public platform and liveness data', () => {
    const controller = new AppController(new HealthService());

    expect(livenessDataSchema.parse(controller.liveness()).status).toBe('ok');
    expect(platformInfoDataSchema.parse(controller.platformInfo()).api_version).toBe('v1');
  });

  it('does not report readiness when MySQL is unconfigured', async () => {
    const previous = process.env['MYSQL_DATABASE_URL'];
    delete process.env['MYSQL_DATABASE_URL'];

    try {
      const readiness = await new HealthService().readiness();
      expect(readinessDataSchema.parse(readiness).status).toBe('not_ready');
      expect(readiness.checks.database.status).toBe('unconfigured');
    } finally {
      if (previous !== undefined) process.env['MYSQL_DATABASE_URL'] = previous;
    }
  });

  it('preserves valid request IDs and replaces invalid ones', () => {
    expect(resolveRequestId('client-request-123')).toBe('client-request-123');
    expect(resolveRequestId('contains spaces')).toMatch(/^req_[0-9a-f-]+$/u);
  });

  it('preserves stable safe error metadata from controller exceptions', () => {
    let status: number | undefined;
    let body: unknown;
    const response: ResponseLike = {
      setHeader: () => undefined,
      status: (value) => {
        status = value;
        return response;
      },
      json: (value) => {
        body = value;
        return value;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ requestId: 'request-12345678', headers: {} }),
      }),
    } as ArgumentsHost;

    new ApiExceptionFilter().catch(
      new HttpException(
        {
          code: 'BINDING_REQUIRED',
          message: 'A verified merchant binding is required',
          retryable: false,
        },
        HttpStatus.CONFLICT,
      ),
      host,
    );

    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body).toEqual({
      error: {
        code: 'BINDING_REQUIRED',
        message: 'A verified merchant binding is required',
        retryable: false,
      },
      request_id: 'request-12345678',
    });
  });
});
