import { describe, expect, it } from 'vitest';

import { livenessDataSchema, platformInfoDataSchema, readinessDataSchema } from '@h5cs/contracts';

import { AppController } from '../src/app.controller.js';
import { HealthService } from '../src/health.service.js';
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
});
