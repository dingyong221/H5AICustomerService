import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import {
  loadDatabaseConfig,
  MySqlPublicSessionRepository,
  PublicSessionUnavailableError,
} from '@h5cs/database';
import type { PublicSessionCreated, PublicSessionHistory } from '@h5cs/database';

type SessionIssuer = Pick<MySqlPublicSessionRepository, 'createSession'> &
  Partial<Pick<MySqlPublicSessionRepository, 'resumeSession' | 'readHistory'>>;

const visitorCookieSeconds = 30 * 24 * 60 * 60;

const canonicalOrigin = (value: string | undefined): URL | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const loopback = ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (
      parsed.origin !== value ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
};

const validNonce = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 32 && decoded.toString('base64url') === value;
};

export class PublicSessionService {
  public constructor(
    private readonly issuer: SessionIssuer | null,
    private readonly secure: boolean,
  ) {}

  public static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): PublicSessionService {
    const origin = canonicalOrigin(environment['CONSUMER_H5_ORIGIN']);
    if (
      environment['PUBLIC_CONVERSATION_ENABLED'] !== 'true' ||
      !origin ||
      (environment['NODE_ENV'] === 'production' && origin.protocol !== 'https:')
    )
      return new PublicSessionService(null, false);
    const database = loadDatabaseConfig(environment);
    const key = environment['VISITOR_CREDENTIAL_HMAC_KEY'];
    if (!database.configured || !key)
      return new PublicSessionService(null, origin.protocol === 'https:');
    try {
      return new PublicSessionService(
        new MySqlPublicSessionRepository(database.config, key),
        origin.protocol === 'https:',
      );
    } catch {
      return new PublicSessionService(null, origin.protocol === 'https:');
    }
  }

  private cookieName(): string {
    return this.secure ? '__Host-h5cs_visitor' : 'h5cs_visitor';
  }

  public visitorNonce(cookieHeader: string | undefined): string | null {
    if (!cookieHeader || cookieHeader.length > 8_192) return null;
    const values = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${this.cookieName()}=`))
      .map((part) => part.slice(this.cookieName().length + 1));
    return values.length === 1 && validNonce(values[0]!) ? values[0]! : null;
  }

  public async create(input: {
    publicSlug: string;
    idempotencyKey: string | undefined;
    cookieHeader: string | undefined;
  }): Promise<{ session: PublicSessionCreated; setCookie: string | null }> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.publicSlug)) {
      throw new NotFoundException('Assistant not available');
    }
    if (!input.idempotencyKey || !/^session_request_[0-9a-f]{32}$/u.test(input.idempotencyKey)) {
      throw new BadRequestException('A valid session request key is required');
    }
    if (!this.issuer) throw new ServiceUnavailableException('Conversation service unavailable');
    const existingNonce = this.visitorNonce(input.cookieHeader);
    const nonce = existingNonce ?? randomBytes(32).toString('base64url');
    try {
      const session = await this.issuer.createSession({
        publicSlug: input.publicSlug,
        sessionRequestId: input.idempotencyKey,
        visitorNonce: nonce,
        now: new Date(),
      });
      return {
        session,
        setCookie:
          existingNonce === null
            ? `${this.cookieName()}=${nonce}; Path=/; Max-Age=${visitorCookieSeconds}; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`
            : null,
      };
    } catch (error) {
      if (error instanceof PublicSessionUnavailableError) {
        throw new NotFoundException('Assistant not available');
      }
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
  }

  public async resume(input: {
    publicSlug: string;
    sessionRequestId: string;
    cookieHeader: string | undefined;
  }): Promise<PublicSessionCreated> {
    if (!this.issuer?.resumeSession) {
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
    const nonce = this.visitorNonce(input.cookieHeader);
    if (!nonce) throw new NotFoundException('Session not available');
    try {
      const session = await this.issuer.resumeSession({
        publicSlug: input.publicSlug,
        sessionRequestId: input.sessionRequestId,
        visitorNonce: nonce,
        now: new Date(),
      });
      if (!session) throw new NotFoundException('Session not available');
      return session;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
  }

  public async history(
    sessionHandle: string,
    cookieHeader: string | undefined,
  ): Promise<PublicSessionHistory> {
    if (!this.issuer?.readHistory) {
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
    const nonce = this.visitorNonce(cookieHeader);
    if (!nonce) throw new NotFoundException('Session not available');
    try {
      const history = await this.issuer.readHistory(sessionHandle, nonce, new Date());
      if (!history) throw new NotFoundException('Session not available');
      return history;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Conversation service unavailable');
    }
  }
}
