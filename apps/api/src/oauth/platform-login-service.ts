import { createHash, timingSafeEqual } from 'node:crypto';

import type { PlatformLoginSessionRecord, PlatformLoginSessionRepository } from '@h5cs/domain';

import type {
  PlatformAccountSession,
  PlatformLoginService,
  PlatformMutationContext,
} from './workbuddy-local-authorization.service.js';
import {
  WorkBuddyLocalAuthorizationUnavailableError,
  WorkBuddyMutationContextInvalidError,
} from './workbuddy-local-authorization.service.js';

const MAX_COOKIE_HEADER_LENGTH = 8_192;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{32,256}$/u;
const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const merchantUserIdPattern = /^[0-9a-f]{32}$/u;

export type PlatformLoginServiceConfig = Readonly<{
  cookieName: string;
  allowedOrigins: readonly string[];
  production: boolean;
}>;

const digest = (value: string): Uint8Array => createHash('sha256').update(value, 'ascii').digest();

const sameDigest = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === 32 &&
  right.byteLength === 32 &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));

const validOrigin = (value: string, production: boolean): boolean => {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return (
      url.origin === value &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      (url.protocol === 'https:' || (!production && url.protocol === 'http:' && loopback))
    );
  } catch {
    return false;
  }
};

const parseCookie = (header: string | undefined, cookieName: string): string | null => {
  if (
    header === undefined ||
    header.length === 0 ||
    header.length > MAX_COOKIE_HEADER_LENGTH ||
    header.includes('\r') ||
    header.includes('\n')
  ) {
    return null;
  }

  const cookies = new Map<string, string>();
  for (const segment of header.split(';')) {
    const pair = segment.trim();
    const separator = pair.indexOf('=');
    if (separator <= 0) return null;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!cookieNamePattern.test(name) || cookies.has(name)) return null;
    cookies.set(name, value);
  }

  const value = cookies.get(cookieName);
  return value !== undefined && opaqueTokenPattern.test(value) ? value : null;
};

const validDate = (value: Date): boolean => Number.isFinite(value.getTime());

const validateSessionRecord = (
  record: PlatformLoginSessionRecord,
  expectedSessionDigest: Uint8Array,
  expectedCsrfDigest: Uint8Array | undefined,
  now: Date,
): boolean =>
  sameDigest(record.sessionDigest, expectedSessionDigest) &&
  record.csrfDigest.byteLength === 32 &&
  (expectedCsrfDigest === undefined || sameDigest(record.csrfDigest, expectedCsrfDigest)) &&
  record.revokedAt === null &&
  merchantUserIdPattern.test(record.merchantUserId) &&
  (record.authenticationLevel === 'primary' || record.authenticationLevel === 'reauthenticated') &&
  validDate(record.authenticatedAt) &&
  validDate(record.expiresAt) &&
  validDate(record.createdAt) &&
  validDate(record.updatedAt) &&
  record.expiresAt.getTime() > now.getTime();

export class RepositoryPlatformLoginService implements PlatformLoginService {
  readonly #repository: PlatformLoginSessionRepository;
  readonly #cookieName: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #clock: () => Date;

  public constructor(
    repository: PlatformLoginSessionRepository,
    config: PlatformLoginServiceConfig,
    clock: () => Date = () => new Date(),
  ) {
    if (!cookieNamePattern.test(config.cookieName)) {
      throw new WorkBuddyLocalAuthorizationUnavailableError(
        'Platform login security configuration is invalid',
      );
    }
    if (config.production && !config.cookieName.startsWith('__Host-')) {
      throw new WorkBuddyLocalAuthorizationUnavailableError(
        'Platform login security configuration is invalid',
      );
    }
    if (
      config.allowedOrigins.length === 0 ||
      config.allowedOrigins.some((origin) => !validOrigin(origin, config.production)) ||
      new Set(config.allowedOrigins).size !== config.allowedOrigins.length
    ) {
      throw new WorkBuddyLocalAuthorizationUnavailableError(
        'Platform login security configuration is invalid',
      );
    }
    this.#repository = repository;
    this.#cookieName = config.cookieName;
    this.#allowedOrigins = new Set(config.allowedOrigins);
    this.#clock = clock;
  }

  public async assertReady(): Promise<void> {
    try {
      await this.#repository.assertReady();
    } catch {
      throw new WorkBuddyLocalAuthorizationUnavailableError();
    }
  }

  public async resolveSession(
    cookieHeader: string | undefined,
  ): Promise<PlatformAccountSession | null> {
    const rawSession = parseCookie(cookieHeader, this.#cookieName);
    if (rawSession === null) return null;
    const sessionDigest = digest(rawSession);
    const now = this.#clock();
    try {
      const record = await this.#repository.resolvePlatformLoginSession(sessionDigest, now);
      if (record === null || !validateSessionRecord(record, sessionDigest, undefined, now)) {
        return null;
      }
      return {
        accountId: record.merchantUserId,
        loginSessionDigest: sessionDigest,
        merchantUserId: record.merchantUserId,
      };
    } catch {
      throw new WorkBuddyLocalAuthorizationUnavailableError();
    }
  }

  public async resolveMutationSession(
    context: PlatformMutationContext,
  ): Promise<PlatformAccountSession | null> {
    const rawSession = parseCookie(context.cookieHeader, this.#cookieName);
    if (
      rawSession === null ||
      context.csrfToken === undefined ||
      !opaqueTokenPattern.test(context.csrfToken) ||
      context.origin === undefined ||
      !this.#allowedOrigins.has(context.origin)
    ) {
      throw new WorkBuddyMutationContextInvalidError();
    }
    const sessionDigest = digest(rawSession);
    const csrfDigest = digest(context.csrfToken);
    const now = this.#clock();
    try {
      const record = await this.#repository.resolvePlatformMutationSession(
        sessionDigest,
        csrfDigest,
        now,
      );
      if (record === null || !validateSessionRecord(record, sessionDigest, csrfDigest, now)) {
        return null;
      }
      return {
        accountId: record.merchantUserId,
        loginSessionDigest: sessionDigest,
        merchantUserId: record.merchantUserId,
      };
    } catch {
      throw new WorkBuddyLocalAuthorizationUnavailableError();
    }
  }
}
