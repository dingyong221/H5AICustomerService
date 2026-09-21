import type { LivenessData, ReadinessData } from '@h5cs/contracts';
import { loadDatabaseConfig, probeDatabase } from '@h5cs/database';

export class WorkerHealth {
  #databaseCheck: ReadinessData['checks']['database'] = {
    status: 'unconfigured',
    reason: 'Database has not been probed',
  };

  public liveness(): LivenessData {
    return {
      status: 'ok',
      service: 'worker',
      timestamp: new Date().toISOString(),
    };
  }

  public readiness(): ReadinessData {
    return {
      status: this.#databaseCheck.status === 'up' ? 'ready' : 'not_ready',
      service: 'worker',
      timestamp: new Date().toISOString(),
      checks: { database: this.#databaseCheck },
    };
  }

  public async probeDatabase(): Promise<void> {
    const databaseConfig = loadDatabaseConfig();
    if (!databaseConfig.configured) {
      this.#databaseCheck = {
        status: 'unconfigured',
        reason: databaseConfig.reason,
      };
      return;
    }

    const probe = await probeDatabase(databaseConfig.config);
    this.#databaseCheck = probe.ok
      ? { status: 'up', latency_ms: probe.latencyMs }
      : { status: 'down', latency_ms: probe.latencyMs, reason: probe.reason };
  }
}
