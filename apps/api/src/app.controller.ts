import { Controller, Get, Res } from '@nestjs/common';
import type { LivenessData, PlatformInfoData, ReadinessData } from '@h5cs/contracts';

import type { ResponseLike } from './http-types.js';
import { HealthService } from './health.service.js';

@Controller()
export class AppController {
  public constructor(private readonly healthService: HealthService) {}

  @Get('/livez')
  public liveness(): LivenessData {
    return {
      status: 'ok',
      service: 'api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('/readyz')
  public async readiness(
    @Res({ passthrough: true }) response: ResponseLike,
  ): Promise<ReadinessData> {
    const readiness = await this.healthService.readiness();
    if (readiness.status !== 'ready') response.status(503);
    return readiness;
  }

  @Get('/api/v1/public/platform-info')
  public platformInfo(): PlatformInfoData {
    return {
      service: 'h5-ai-customer-service',
      api_version: 'v1',
      environment: process.env['APP_ENV'] ?? 'development',
    };
  }
}
