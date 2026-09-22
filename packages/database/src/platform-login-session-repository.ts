import type {
  PlatformAuthenticationLevel,
  PlatformLoginSessionRecord,
  PlatformLoginSessionRepository,
} from '@h5cs/domain';
import { platformAuthenticationLevels, toMerchantUserId } from '@h5cs/domain';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';
import { probeDatabase } from './config.js';
import { IdentityAuthorizationPersistenceError } from './identity-authorization-repository.js';

type PlatformLoginSessionRow = RowDataPacket & {
  session_digest: Buffer;
  merchant_user_id: Buffer;
  csrf_digest: Buffer;
  authentication_level: string;
  authenticated_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const strictDigest = (value: Uint8Array, field: string): Buffer => {
  if (value.byteLength !== 32) {
    throw new IdentityAuthorizationPersistenceError(`${field} must contain exactly 32 bytes`);
  }
  return Buffer.from(value);
};

const idBuffer = (value: string, field: string): Buffer => {
  if (!/^[0-9a-f]{32}$/iu.test(value)) {
    throw new IdentityAuthorizationPersistenceError(`${field} must be a 32-character hex ID`);
  }
  return Buffer.from(value, 'hex');
};

const idString = (value: Buffer, field: string): string => {
  if (value.byteLength !== 16) {
    throw new IdentityAuthorizationPersistenceError(`${field} must contain exactly 16 bytes`);
  }
  return value.toString('hex');
};

const validDate = (value: Date, field: string): Date => {
  if (!Number.isFinite(value.getTime())) {
    throw new IdentityAuthorizationPersistenceError(`${field} is invalid`);
  }
  return value;
};

const authenticationLevel = (value: string): PlatformAuthenticationLevel => {
  const level = platformAuthenticationLevels.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new IdentityAuthorizationPersistenceError(
      'Stored platform authentication level is invalid',
    );
  }
  return level;
};

const toRecord = (row: PlatformLoginSessionRow): PlatformLoginSessionRecord => ({
  sessionDigest: Uint8Array.from(row.session_digest),
  merchantUserId: toMerchantUserId(idString(row.merchant_user_id, 'merchantUserId')),
  csrfDigest: Uint8Array.from(row.csrf_digest),
  authenticationLevel: authenticationLevel(row.authentication_level),
  authenticatedAt: row.authenticated_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class MySqlPlatformLoginSessionRepository implements PlatformLoginSessionRepository {
  readonly #config: DatabaseConnectionConfig;

  public constructor(config: DatabaseConnectionConfig) {
    this.#config = config;
  }

  public async assertReady(): Promise<void> {
    const probe = await probeDatabase(this.#config);
    if (!probe.ok) throw new IdentityAuthorizationPersistenceError();
  }

  public async storePlatformLoginSession(record: PlatformLoginSessionRecord): Promise<void> {
    const sessionDigest = strictDigest(record.sessionDigest, 'sessionDigest');
    const csrfDigest = strictDigest(record.csrfDigest, 'csrfDigest');
    this.#validateRecord(record);
    if (record.revokedAt !== null) {
      throw new IdentityAuthorizationPersistenceError('A new platform session cannot be revoked');
    }
    await this.#withConnection(async (connection) => {
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO platform_login_session
           (session_digest, merchant_user_id, csrf_digest, authentication_level,
            authenticated_at, expires_at, revoked_at, created_at, updated_at)
         SELECT ?, u.id, ?, ?, ?, ?, NULL, ?, ?
           FROM merchant_user u
          WHERE u.id = ? AND u.status = 'active'`,
        [
          sessionDigest,
          csrfDigest,
          record.authenticationLevel,
          record.authenticatedAt,
          record.expiresAt,
          record.createdAt,
          record.updatedAt,
          idBuffer(record.merchantUserId, 'merchantUserId'),
        ],
      );
      if (result.affectedRows !== 1) {
        throw new IdentityAuthorizationPersistenceError(
          'Platform login session account is unavailable',
        );
      }
    });
  }

  public async resolvePlatformLoginSession(
    sessionDigestValue: Uint8Array,
    now: Date,
  ): Promise<PlatformLoginSessionRecord | null> {
    return this.#resolve(sessionDigestValue, undefined, now);
  }

  public async resolvePlatformMutationSession(
    sessionDigestValue: Uint8Array,
    csrfDigestValue: Uint8Array,
    now: Date,
  ): Promise<PlatformLoginSessionRecord | null> {
    return this.#resolve(sessionDigestValue, csrfDigestValue, now);
  }

  public async revokePlatformLoginSession(
    sessionDigestValue: Uint8Array,
    now: Date,
  ): Promise<boolean> {
    const sessionDigest = strictDigest(sessionDigestValue, 'sessionDigest');
    validDate(now, 'now');
    return this.#withTransaction(async (connection) => {
      const [rows] = await connection.execute<PlatformLoginSessionRow[]>(
        `SELECT s.session_digest, s.merchant_user_id, s.csrf_digest,
                s.authentication_level, s.authenticated_at, s.expires_at,
                s.revoked_at, s.created_at, s.updated_at
           FROM platform_login_session s
          WHERE s.session_digest = ?
          LIMIT 1
          FOR UPDATE`,
        [sessionDigest],
      );
      const row = rows[0];
      if (row === undefined || row.revoked_at !== null) return false;
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE platform_login_session
            SET revoked_at = ?, updated_at = ?
          WHERE session_digest = ? AND revoked_at IS NULL`,
        [now, now, sessionDigest],
      );
      return result.affectedRows === 1;
    });
  }

  async #resolve(
    sessionDigestValue: Uint8Array,
    csrfDigestValue: Uint8Array | undefined,
    now: Date,
  ): Promise<PlatformLoginSessionRecord | null> {
    const sessionDigest = strictDigest(sessionDigestValue, 'sessionDigest');
    const csrfDigest =
      csrfDigestValue === undefined ? undefined : strictDigest(csrfDigestValue, 'csrfDigest');
    validDate(now, 'now');
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<PlatformLoginSessionRow[]>(
        `SELECT s.session_digest, s.merchant_user_id, s.csrf_digest,
                s.authentication_level, s.authenticated_at, s.expires_at,
                s.revoked_at, s.created_at, s.updated_at
           FROM platform_login_session s
           JOIN merchant_user u ON u.id = s.merchant_user_id
          WHERE s.session_digest = ?
            ${csrfDigest === undefined ? '' : 'AND s.csrf_digest = ?'}
            AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'
          LIMIT 1`,
        csrfDigest === undefined ? [sessionDigest, now] : [sessionDigest, csrfDigest, now],
      );
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    });
  }

  #validateRecord(record: PlatformLoginSessionRecord): void {
    idBuffer(record.merchantUserId, 'merchantUserId');
    if (!platformAuthenticationLevels.includes(record.authenticationLevel)) {
      throw new IdentityAuthorizationPersistenceError('authenticationLevel is invalid');
    }
    validDate(record.authenticatedAt, 'authenticatedAt');
    validDate(record.expiresAt, 'expiresAt');
    validDate(record.createdAt, 'createdAt');
    validDate(record.updatedAt, 'updatedAt');
    if (
      record.expiresAt.getTime() <= record.authenticatedAt.getTime() ||
      record.expiresAt.getTime() <= record.createdAt.getTime() ||
      record.authenticatedAt.getTime() > record.createdAt.getTime() ||
      record.updatedAt.getTime() < record.createdAt.getTime()
    ) {
      throw new IdentityAuthorizationPersistenceError('Platform login session times are invalid');
    }
  }

  async #withConnection<TResult>(
    operation: (connection: Connection) => Promise<TResult>,
  ): Promise<TResult> {
    const connection = await this.#config.openConnection();
    try {
      return await operation(connection);
    } finally {
      await connection.end();
    }
  }

  async #withTransaction<TResult>(
    operation: (connection: Connection) => Promise<TResult>,
  ): Promise<TResult> {
    return this.#withConnection(async (connection) => {
      await connection.beginTransaction();
      try {
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }
}
