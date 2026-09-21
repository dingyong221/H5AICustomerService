import { Injectable } from '@nestjs/common';
import type { ReadinessData } from '@h5cs/contracts';
import { loadDatabaseConfig, probeDatabase } from '@h5cs/database';

@Injectable()
export class HealthService {
  public async readiness(): Promise<ReadinessData> {
    const timestamp = new Date().toISOString();
    const databaseConfig = loadDatabaseConfig();

    if (!databaseConfig.configured) {
      return {
        status: 'not_ready',
        service: 'api',
        timestamp,
        checks: {
          database: {
            status: 'unconfigured',
            reason: databaseConfig.reason,
          },
        },
      };
    }

    const probe = await probeDatabase(databaseConfig.config);
    if (!probe.ok) {
      return {
        status: 'not_ready',
        service: 'api',
        timestamp,
        checks: {
          database: {
            status: 'down',
            latency_ms: probe.latencyMs,
            reason: probe.reason,
          },
        },
      };
    }

    return {
      status: 'ready',
      service: 'api',
      timestamp,
      checks: {
        database: {
          status: 'up',
          latency_ms: probe.latencyMs,
        },
      },
    };
  }
}
