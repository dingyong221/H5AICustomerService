import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  loadDatabaseConfig,
  MySqlPublicSessionRepository,
  PublicSessionUnavailableError,
  PublicTurnConflictError,
} from '@h5cs/database';
import type { PublicTurnResult } from '@h5cs/database';

type TurnStore = Pick<MySqlPublicSessionRepository, 'acceptTurn' | 'readTurn'>;

const originFrom = (value: string | undefined, production: boolean): string | null => {
  if (!value) return null;
  try {
    const origin = new URL(value);
    const loopback = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
    if (
      origin.origin !== value ||
      (origin.protocol !== 'https:' && (production || origin.protocol !== 'http:' || !loopback))
    )
      return null;
    return origin.origin;
  } catch {
    return null;
  }
};

const waitForPoll = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });

export class PublicTurnService {
  public constructor(
    private readonly store: TurnStore | null,
    private readonly origin: string | null,
    private readonly pollIntervalMs = 1_000,
  ) {}

  public static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): PublicTurnService {
    const origin = originFrom(
      environment['CONSUMER_H5_ORIGIN'],
      environment['NODE_ENV'] === 'production',
    );
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

  public isConfigured(): boolean {
    return this.store !== null && this.origin !== null;
  }

  public async send(input: {
    sessionHandle: string;
    visitorNonce: string | null;
    idempotencyKey: string | undefined;
    body: unknown;
  }): Promise<{
    turnId: string;
    traceId: string;
    state: 'accepted';
    eventsUrl: string;
    resultUrl: string;
  }> {
    if (!this.store || !this.origin)
      throw new ServiceUnavailableException('Conversation service unavailable');
    if (!input.visitorNonce) throw new NotFoundException('Session not available');
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
      body['content'].trim().length < 1 ||
      body['content'].length > 2_000
    )
      throw new BadRequestException('Invalid message');
    try {
      const accepted = await this.store.acceptTurn({
        sessionHandle: input.sessionHandle,
        visitorNonce: input.visitorNonce,
        clientMessageId: body['clientMessageId'],
        content: body['content'],
        now: new Date(),
      });
      const path = `/api/v1/public/sessions/${encodeURIComponent(input.sessionHandle)}/turns/${accepted.turnId}`;
      return {
        ...accepted,
        state: 'accepted',
        eventsUrl: `${this.origin}${path}/events`,
        resultUrl: `${this.origin}${path}`,
      };
    } catch (error) {
      if (error instanceof PublicTurnConflictError) throw new ConflictException(error.code);
      if (error instanceof PublicSessionUnavailableError)
        throw new NotFoundException('Session not available');
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
  }

  public async read(
    sessionHandle: string,
    visitorNonce: string | null,
    turnId: string,
  ): Promise<PublicTurnResult> {
    if (!this.store) throw new ServiceUnavailableException('Conversation service unavailable');
    if (!visitorNonce) throw new NotFoundException('Turn not available');
    try {
      const result = await this.store.readTurn(sessionHandle, visitorNonce, turnId, new Date());
      if (!result) throw new NotFoundException('Turn not available');
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
  }

  public async *stream(
    sessionHandle: string,
    visitorNonce: string | null,
    turnId: string,
    signal: AbortSignal,
    first: PublicTurnResult,
  ): AsyncGenerator<PublicTurnResult> {
    let previousState = first.state;
    while (previousState !== 'completed' && previousState !== 'failed' && !signal.aborted) {
      await waitForPoll(this.pollIntervalMs, signal);
      if (signal.aborted) return;
      const result = await this.read(sessionHandle, visitorNonce, turnId);
      if (signal.aborted) return;
      if (result.state !== previousState) {
        previousState = result.state;
        yield result;
      }
    }
  }
}
