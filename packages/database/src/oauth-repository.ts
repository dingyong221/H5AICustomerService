import { createHash } from 'node:crypto';

import {
  OAuthRepositoryUnavailableError,
  oauthMcpScope,
  type OAuthAuthorizationCodeRecord,
  type OAuthPublicClient,
  type OAuthRefreshRotationResult,
  type OAuthRefreshTokenContext,
  type OAuthRefreshTokenRecord,
  type OAuthRefreshTokenReplacement,
  type OAuthRepository,
} from '@h5cs/domain';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';
import { probeDatabase } from './config.js';

type OAuthClientRow = RowDataPacket & {
  client_id: string;
  client_name: string | null;
  redirect_uris: string | readonly unknown[];
  created_at: Date;
};

type OAuthCodeRow = RowDataPacket & {
  client_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  code_challenge: string;
  binding_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
};

type OAuthRefreshRow = RowDataPacket & {
  family_id_digest: Buffer;
  family_id: string;
  client_id: string;
  binding_id: string;
  resource: string;
  scope: string;
  family_revoked_at: Date | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

const digestOpaqueId = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

const strictDigest = (value: Uint8Array, field: string): Buffer => {
  if (value.byteLength !== 32) {
    throw new OAuthPersistenceError(`${field} must contain exactly 32 bytes`);
  }
  return Buffer.from(value);
};

const validDate = (value: Date, field: string): Date => {
  if (!Number.isFinite(value.getTime())) throw new OAuthPersistenceError(`${field} is invalid`);
  return value;
};

const boundedText = (value: string, field: string, maximum: number): string => {
  if (value.length === 0 || value.length > maximum) {
    throw new OAuthPersistenceError(`${field} length is invalid`);
  }
  return value;
};

const parseRedirectUris = (value: string | readonly unknown[]): readonly string[] => {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 2_048)
  ) {
    throw new OAuthPersistenceError('Stored OAuth redirect URIs are invalid');
  }
  return parsed as readonly string[];
};

const requireScope = (value: string): typeof oauthMcpScope => {
  if (value !== oauthMcpScope) throw new OAuthPersistenceError('Stored OAuth scope is invalid');
  return value;
};

const rowToCode = (row: OAuthCodeRow, codeDigest: Uint8Array): OAuthAuthorizationCodeRecord => ({
  codeDigest,
  clientId: row.client_id,
  redirectUri: row.redirect_uri,
  resource: row.resource,
  scope: requireScope(row.scope),
  codeChallenge: row.code_challenge,
  bindingId: row.binding_id,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

const rowToRefresh = (row: OAuthRefreshRow, tokenDigest: Uint8Array): OAuthRefreshTokenRecord => ({
  tokenDigest,
  familyId: row.family_id,
  clientId: row.client_id,
  bindingId: row.binding_id,
  resource: row.resource,
  scope: requireScope(row.scope),
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

export class OAuthPersistenceError extends OAuthRepositoryUnavailableError {
  public constructor(message = 'OAuth persistence is unavailable') {
    super(message);
    this.name = 'OAuthPersistenceError';
  }
}

export class MySqlOAuthRepository implements OAuthRepository {
  readonly #config: DatabaseConnectionConfig;

  public constructor(config: DatabaseConnectionConfig) {
    this.#config = config;
  }

  public async assertReady(): Promise<void> {
    const probe = await probeDatabase(this.#config);
    if (!probe.ok) throw new OAuthPersistenceError();
  }

  public async registerPublicClient(client: OAuthPublicClient): Promise<void> {
    const clientId = boundedText(client.clientId, 'clientId', 128);
    if (client.redirectUris.length === 0 || client.redirectUris.length > 10) {
      throw new OAuthPersistenceError('redirectUris length is invalid');
    }
    for (const redirectUri of client.redirectUris) {
      boundedText(redirectUri, 'redirectUri', 2_048);
    }
    if (client.clientName !== undefined) boundedText(client.clientName, 'clientName', 200);
    validDate(client.createdAt, 'createdAt');

    await this.#withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO oauth_public_client
           (client_id_digest, client_id, client_name, redirect_uris, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          digestOpaqueId(clientId),
          clientId,
          client.clientName ?? null,
          JSON.stringify(client.redirectUris),
          client.createdAt,
        ],
      );
    });
  }

  public async findPublicClient(clientId: string): Promise<OAuthPublicClient | null> {
    boundedText(clientId, 'clientId', 128);
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<OAuthClientRow[]>(
        `SELECT client_id, client_name, redirect_uris, created_at
           FROM oauth_public_client
          WHERE client_id_digest = ?
          LIMIT 1`,
        [digestOpaqueId(clientId)],
      );
      const row = rows[0];
      if (row === undefined || row.client_id !== clientId) return null;
      return {
        clientId: row.client_id,
        ...(row.client_name === null ? {} : { clientName: row.client_name }),
        redirectUris: parseRedirectUris(row.redirect_uris),
        createdAt: row.created_at,
      };
    });
  }

  public async storeAuthorizationCode(record: OAuthAuthorizationCodeRecord): Promise<void> {
    const codeDigest = strictDigest(record.codeDigest, 'codeDigest');
    this.#validateAuthorizationCode(record);
    await this.#withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO oauth_authorization_code
           (code_digest, client_id_digest, redirect_uri, resource, scope, code_challenge,
            binding_id, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          codeDigest,
          digestOpaqueId(record.clientId),
          record.redirectUri,
          record.resource,
          record.scope,
          record.codeChallenge,
          record.bindingId,
          record.expiresAt,
          record.createdAt,
        ],
      );
    });
  }

  public async consumeAuthorizationCode(
    codeDigestValue: Uint8Array,
    now: Date,
  ): Promise<OAuthAuthorizationCodeRecord | null> {
    const codeDigest = strictDigest(codeDigestValue, 'codeDigest');
    validDate(now, 'now');
    return this.#withTransaction(async (connection) => {
      const [rows] = await connection.execute<OAuthCodeRow[]>(
        `SELECT c.client_id, a.redirect_uri, a.resource, a.scope, a.code_challenge,
                a.binding_id, a.expires_at, a.consumed_at, a.created_at
           FROM oauth_authorization_code a
           JOIN oauth_public_client c ON c.client_id_digest = a.client_id_digest
          WHERE a.code_digest = ?
          LIMIT 1
          FOR UPDATE`,
        [codeDigest],
      );
      const row = rows[0];
      if (
        row === undefined ||
        row.consumed_at !== null ||
        row.expires_at.getTime() <= now.getTime()
      ) {
        return null;
      }
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE oauth_authorization_code
            SET consumed_at = ?
          WHERE code_digest = ? AND consumed_at IS NULL`,
        [now, codeDigest],
      );
      if (result.affectedRows !== 1) return null;
      return rowToCode(row, Uint8Array.from(codeDigest));
    });
  }

  public async storeRefreshToken(record: OAuthRefreshTokenRecord): Promise<void> {
    const tokenDigest = strictDigest(record.tokenDigest, 'tokenDigest');
    this.#validateRefreshRecord(record);
    const familyIdDigest = digestOpaqueId(record.familyId);
    await this.#withTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO oauth_refresh_token_family
           (family_id_digest, family_id, client_id_digest, binding_id, resource, scope,
            revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          familyIdDigest,
          record.familyId,
          digestOpaqueId(record.clientId),
          record.bindingId,
          record.resource,
          record.scope,
          record.createdAt,
        ],
      );
      await connection.execute(
        `INSERT INTO oauth_refresh_token
           (token_digest, family_id_digest, replacement_token_digest, expires_at, used_at,
            created_at)
         VALUES (?, ?, NULL, ?, NULL, ?)`,
        [tokenDigest, familyIdDigest, record.expiresAt, record.createdAt],
      );
    });
  }

  public async rotateRefreshToken(
    tokenDigestValue: Uint8Array,
    replacement: OAuthRefreshTokenReplacement,
    expected: OAuthRefreshTokenContext,
    now: Date,
  ): Promise<OAuthRefreshRotationResult> {
    const tokenDigest = strictDigest(tokenDigestValue, 'tokenDigest');
    const replacementDigest = strictDigest(replacement.tokenDigest, 'replacement.tokenDigest');
    validDate(replacement.createdAt, 'replacement.createdAt');
    validDate(replacement.expiresAt, 'replacement.expiresAt');
    if (replacement.expiresAt.getTime() <= replacement.createdAt.getTime()) {
      throw new OAuthPersistenceError('replacement expiry must be after creation');
    }
    validDate(now, 'now');
    this.#validateContext(expected);

    return this.#withTransaction(async (connection) => {
      const [rows] = await connection.execute<OAuthRefreshRow[]>(
        `SELECT t.family_id_digest, f.family_id, c.client_id, f.binding_id, f.resource, f.scope,
                f.revoked_at AS family_revoked_at, t.expires_at, t.used_at, t.created_at
           FROM oauth_refresh_token t
           JOIN oauth_refresh_token_family f ON f.family_id_digest = t.family_id_digest
           JOIN oauth_public_client c ON c.client_id_digest = f.client_id_digest
          WHERE t.token_digest = ?
          LIMIT 1
          FOR UPDATE`,
        [tokenDigest],
      );
      const row = rows[0];
      if (row === undefined) return { status: 'invalid' };

      if (row.family_revoked_at !== null || row.used_at !== null) {
        await this.#revokeFamily(connection, row.family_id_digest, now);
        return { status: 'replayed' };
      }
      if (
        row.client_id !== expected.clientId ||
        row.resource !== expected.resource ||
        row.scope !== expected.scope
      ) {
        await this.#revokeFamily(connection, row.family_id_digest, now);
        return { status: 'invalid' };
      }
      if (row.expires_at.getTime() <= now.getTime()) return { status: 'invalid' };

      await connection.execute(
        `INSERT INTO oauth_refresh_token
           (token_digest, family_id_digest, replacement_token_digest, expires_at, used_at,
            created_at)
         VALUES (?, ?, NULL, ?, NULL, ?)`,
        [replacementDigest, row.family_id_digest, replacement.expiresAt, replacement.createdAt],
      );
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE oauth_refresh_token
            SET used_at = ?, replacement_token_digest = ?
          WHERE token_digest = ? AND used_at IS NULL`,
        [now, replacementDigest, tokenDigest],
      );
      if (result.affectedRows !== 1) {
        throw new OAuthPersistenceError('Refresh token rotation lost its row lock');
      }
      return {
        status: 'rotated',
        previous: rowToRefresh(row, Uint8Array.from(tokenDigest)),
      };
    });
  }

  #validateAuthorizationCode(record: OAuthAuthorizationCodeRecord): void {
    boundedText(record.clientId, 'clientId', 128);
    boundedText(record.redirectUri, 'redirectUri', 2_048);
    boundedText(record.resource, 'resource', 2_048);
    if (record.scope !== oauthMcpScope) throw new OAuthPersistenceError('scope is invalid');
    boundedText(record.codeChallenge, 'codeChallenge', 128);
    boundedText(record.bindingId, 'bindingId', 191);
    validDate(record.expiresAt, 'expiresAt');
    validDate(record.createdAt, 'createdAt');
    if (record.expiresAt.getTime() <= record.createdAt.getTime()) {
      throw new OAuthPersistenceError('authorization-code expiry must be after creation');
    }
  }

  #validateRefreshRecord(record: OAuthRefreshTokenRecord): void {
    boundedText(record.familyId, 'familyId', 128);
    this.#validateContext(record);
    boundedText(record.bindingId, 'bindingId', 191);
    validDate(record.expiresAt, 'expiresAt');
    validDate(record.createdAt, 'createdAt');
    if (record.expiresAt.getTime() <= record.createdAt.getTime()) {
      throw new OAuthPersistenceError('refresh-token expiry must be after creation');
    }
  }

  #validateContext(context: OAuthRefreshTokenContext): void {
    boundedText(context.clientId, 'clientId', 128);
    boundedText(context.resource, 'resource', 2_048);
    if (context.scope !== oauthMcpScope) throw new OAuthPersistenceError('scope is invalid');
  }

  async #revokeFamily(connection: Connection, familyIdDigest: Buffer, now: Date): Promise<void> {
    await connection.execute(
      `UPDATE oauth_refresh_token_family
          SET revoked_at = COALESCE(revoked_at, ?)
        WHERE family_id_digest = ?`,
      [now, familyIdDigest],
    );
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
