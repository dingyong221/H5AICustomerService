import type { LivenessData, ReadinessData } from '@h5cs/contracts';
import { loadDatabaseConfig, probeDatabase } from '@h5cs/database';

export class WorkerHealth {
  #databaseCheck: ReadinessData['checks']['database'] = {
    status: 'unconfigured',
    reason: 'Database has not been probed',
  };
  #conversationReady = false;

  public setConversationReady(ready: boolean): void {
    this.#conversationReady = ready;
  }

  public databaseAvailable(): boolean {
    return this.#databaseCheck.status === 'up';
  }

  public liveness(): LivenessData {
    return {
      status: 'ok',
      service: 'worker',
      timestamp: new Date().toISOString(),
    };
  }

  public readiness(): ReadinessData {
    return {
      status:
        this.#databaseCheck.status === 'up' && this.#conversationReady ? 'ready' : 'not_ready',
      service: 'worker',
      timestamp: new Date().toISOString(),
      checks: {
        database: this.#databaseCheck,
        conversation: this.#conversationReady
          ? { status: 'up' }
          : { status: 'unconfigured', reason: 'Conversation job dispatch is disabled' },
      },
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
