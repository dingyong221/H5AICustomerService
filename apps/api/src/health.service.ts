import { Injectable } from '@nestjs/common';
import type { ReadinessData } from '@h5cs/contracts';
import { loadDatabaseConfig, probeDatabase } from '@h5cs/database';

import { PublicSessionService } from './public/public-session.service.js';
import { PublicTurnService } from './public/public-turn.service.js';

@Injectable()
export class HealthService {
  public constructor(
    private readonly publicSessions: PublicSessionService = PublicSessionService.fromEnvironment(),
    private readonly publicTurns: PublicTurnService = PublicTurnService.fromEnvironment(),
  ) {}

  public async readiness(): Promise<ReadinessData> {
    const timestamp = new Date().toISOString();
    let database: ReadinessData['checks']['database'];
    try {
      const databaseConfig = loadDatabaseConfig();
      if (!databaseConfig.configured) {
        database = { status: 'unconfigured', reason: databaseConfig.reason };
      } else {
        const probe = await probeDatabase(databaseConfig.config);
        database = probe.ok
          ? { status: 'up', latency_ms: probe.latencyMs }
          : { status: 'down', latency_ms: probe.latencyMs, reason: probe.reason };
      }
    } catch {
      database = { status: 'unconfigured', reason: 'Database configuration is invalid' };
    }
    const conversationEnabled = process.env['PUBLIC_CONVERSATION_ENABLED'] === 'true';
    let conversation: NonNullable<ReadinessData['checks']['conversation']>;
    if (!conversationEnabled) {
      conversation = { status: 'unconfigured', reason: 'Public conversation is disabled' };
    } else if (database.status !== 'up') {
      conversation = { status: 'down', reason: 'Database is unavailable' };
    } else {
      conversation =
        this.publicSessions.isConfigured() && this.publicTurns.isConfigured()
          ? { status: 'up' }
          : { status: 'unconfigured', reason: 'Public conversation configuration is incomplete' };
    }
    return {
      status:
        database.status === 'up' && (!conversationEnabled || conversation.status === 'up')
          ? 'ready'
          : 'not_ready',
      service: 'api',
      timestamp,
      checks: { database, conversation },
    };
  }
}
