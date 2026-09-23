import {
  BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';

import {
  loadDatabaseConfig, MySqlPublicSessionRepository,
  PublicSessionUnavailableError, PublicTurnConflictError,
} from '@h5cs/database';
import type { PublicTurnResult } from '@h5cs/database';

type TurnStore = Pick<MySqlPublicSessionRepository, 'acceptTurn' | 'readTurn'>;

const originFrom = (value: string | undefined, production: boolean): string | null => {
  if (!value) return null;
  try {
    const origin = new URL(value);
    const loopback = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
    if (origin.origin !== value || (origin.protocol !== 'https:' &&
      (production || origin.protocol !== 'http:' || !loopback))) return null;
    return origin.origin;
  } catch {
    return null;
  }
};

export class PublicTurnService {
  public constructor(
    private readonly store: TurnStore | null,
    private readonly origin: string | null,
  ) {}

  public static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): PublicTurnService {
    const origin = originFrom(environment['CONSUMER_H5_ORIGIN'], environment['NODE_ENV'] === 'production');
    if (environment['PUBLIC_CONVERSATION_ENABLED'] !== 'true' || !origin) {
      return new PublicTurnService(null, null);
    }
    const database = loadDatabaseConfig(environment);
    const key = environment['VISITOR_CREDENTIAL_HMAC_KEY'];
    if (!database.configured || !key) return new PublicTurnService(null, null);
    try {
      return new PublicTurnService(new MySqlPublicSessionRepository(database.config, key), origin);
    } catch {
      return new PublicTurnService(null, null);
    }
  }

  public async send(input: {
    sessionHandle: string;
    idempotencyKey: string | undefined;
    body: unknown;
  }): Promise<{
    turnId: string;
    traceId: string;
    state: 'accepted';
    eventsUrl: string;
    resultUrl: string;
  }> {
    if (!this.store || !this.origin) throw new ServiceUnavailableException('Conversation service unavailable');
    if (typeof input.body !== 'object' || input.body === null || Array.isArray(input.body)) {
      throw new BadRequestException('Invalid message');
    }
    const body = input.body as Record<string, unknown>;
    if (
      Object.keys(body).length !== 2 ||
      typeof body['clientMessageId'] !== 'string' ||
      typeof body['content'] !== 'string' ||
      !/^message_[0-9a-f]{32}$/u.test(body['clientMessageId']) ||
      input.idempotencyKey !== body['clientMessageId'] ||
      body['content'].trim().length < 1 || body['content'].length > 2_000
    ) throw new BadRequestException('Invalid message');
    try {
      const accepted = await this.store.acceptTurn({
        sessionHandle: input.sessionHandle,
        clientMessageId: body['clientMessageId'],
        content: body['content'],
        now: new Date(),
      });
      const path = `/api/v1/public/sessions/${encodeURIComponent(input.sessionHandle)}/turns/${accepted.turnId}`;
      return {
        ...accepted, state: 'accepted',
        eventsUrl: `${this.origin}${path}/events`,
        resultUrl: `${this.origin}${path}`,
      };
    } catch (error) {
      if (error instanceof PublicTurnConflictError) throw new ConflictException(error.code);
      if (error instanceof PublicSessionUnavailableError) throw new NotFoundException('Session not available');
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
  }

  public async read(sessionHandle: string, turnId: string): Promise<PublicTurnResult> {
    if (!this.store) throw new ServiceUnavailableException('Conversation service unavailable');
    try {
      const result = await this.store.readTurn(sessionHandle, turnId, new Date());
      if (!result) throw new NotFoundException('Turn not available');
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
  }
}
