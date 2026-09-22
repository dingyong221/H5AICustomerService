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
  consent_grant_id: Buffer;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  code_challenge: string;
  binding_id: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
  grant_binding_id: string;
  grant_status: string;
  grant_revoked_at: Date | null;
  transaction_digest: Buffer;
  transaction_step: string;
  transaction_consumed_at: Date | null;
  transaction_expires_at: Date;
  transaction_redirect_uri: string;
  transaction_code_challenge: string;
  account_status: string;
  merchant_status: string;
  membership_status: string;
  identity_status: string;
  identity_revoked_at: Date | null;
};

type OAuthRefreshRow = RowDataPacket & {
  family_id_digest: Buffer;
  family_id: string;
  consent_grant_id: Buffer;
  client_id: string;
  binding_id: string;
  resource: string;
  scope: string;
  family_revoked_at: Date | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
  grant_binding_id: string;
  grant_status: string;
  grant_revoked_at: Date | null;
  account_status: string;
  merchant_status: string;
  membership_status: string;
  identity_status: string;
  identity_revoked_at: Date | null;
};

type GrantContextRow = RowDataPacket & {
  id: Buffer;
  binding_id: string;
  client_id: string;
  resource: string;
  scope: string;
  status: string;
  revoked_at: Date | null;
  authorization_transaction_digest: Buffer;
  transaction_step: string;
  transaction_consumed_at: Date | null;
  transaction_expires_at: Date;
  account_status: string;
  merchant_status: string;
  membership_status: string;
  identity_status: string;
  identity_revoked_at: Date | null;
};

const digestOpaqueId = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

const idBuffer = (value: string, field: string): Buffer => {
  if (!/^[0-9a-f]{32}$/iu.test(value)) {
    throw new OAuthPersistenceError(`${field} must be a 32-character hex ID`);
  }
  return Buffer.from(value, 'hex');
};

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
  consentGrantId: row.consent_grant_id.toString('hex'),
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

const rowToRefresh = (row: OAuthRefreshRow, tokenDigest: Uint8Array): OAuthRefreshTokenRecord => ({
  tokenDigest,
  familyId: row.family_id,
  clientId: row.client_id,
  bindingId: row.binding_id,
  consentGrantId: row.consent_grant_id.toString('hex'),
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
    strictDigest(record.codeDigest, 'codeDigest');
    this.#validateAuthorizationCode(record);
    idBuffer(record.consentGrantId ?? '', 'consentGrantId');
    throw new OAuthPersistenceError(
      'Authorization code issuance requires atomic consent activation',
    );
  }

  public async consumeAuthorizationCode(
    codeDigestValue: Uint8Array,
    now: Date,
  ): Promise<OAuthAuthorizationCodeRecord | null> {
    const codeDigest = strictDigest(codeDigestValue, 'codeDigest');
    validDate(now, 'now');
    return this.#withTransaction(async (connection) => {
      const [rows] = await connection.execute<OAuthCodeRow[]>(
        `SELECT a.consent_grant_id, c.client_id, a.redirect_uri, a.resource, a.scope,
                a.code_challenge, a.binding_id, a.expires_at, a.consumed_at, a.created_at,
                g.binding_id AS grant_binding_id, g.status AS grant_status,
                g.revoked_at AS grant_revoked_at,
                t.transaction_digest, t.step AS transaction_step,
                t.consumed_at AS transaction_consumed_at,
                t.expires_at AS transaction_expires_at,
                u.status AS account_status, m.status AS merchant_status,
                mm.status AS membership_status, e.status AS identity_status,
                e.revoked_at AS identity_revoked_at
           FROM oauth_authorization_code a
           JOIN oauth_public_client c ON c.client_id_digest = a.client_id_digest
           JOIN connector_consent_grant g
             ON g.id = a.consent_grant_id
            AND g.client_id_digest = a.client_id_digest
            AND g.binding_id = a.binding_id AND g.resource = a.resource AND g.scope = a.scope
           JOIN connector_authorization_transaction t
             ON t.transaction_digest = g.authorization_transaction_digest
            AND t.client_id_digest = a.client_id_digest
            AND t.redirect_uri = a.redirect_uri AND t.resource = a.resource
            AND t.scope = a.scope AND t.code_challenge = a.code_challenge
           JOIN merchant_user u ON u.id = g.merchant_user_id
           JOIN merchant m ON m.id = g.merchant_id
           JOIN merchant_membership mm
             ON mm.merchant_id = g.merchant_id AND mm.merchant_user_id = g.merchant_user_id
           JOIN external_identity e
             ON e.id = g.external_identity_id AND e.merchant_user_id = g.merchant_user_id
          WHERE a.code_digest = ?
          LIMIT 1
          FOR UPDATE`,
        [codeDigest],
      );
      const row = rows[0];
      if (
        row === undefined ||
        row.consumed_at !== null ||
        row.expires_at.getTime() <= now.getTime() ||
        row.grant_binding_id !== row.binding_id ||
        row.grant_status !== 'active' ||
        row.grant_revoked_at !== null ||
        row.transaction_step !== 'code_issued' ||
        row.transaction_consumed_at !== null ||
        row.transaction_expires_at.getTime() <= now.getTime() ||
        row.account_status !== 'active' ||
        row.merchant_status !== 'active' ||
        row.membership_status !== 'active' ||
        row.identity_status !== 'active' ||
        row.identity_revoked_at !== null
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
      const [transactionResult] = await connection.execute<ResultSetHeader>(
        `UPDATE connector_authorization_transaction
            SET step = 'consumed', consumed_at = ?, updated_at = ?
          WHERE transaction_digest = ? AND step = 'code_issued' AND consumed_at IS NULL`,
        [now, now, row.transaction_digest],
      );
      if (transactionResult.affectedRows !== 1) {
        throw new OAuthPersistenceError('Authorization transaction changed during code consume');
      }
      return rowToCode(row, Uint8Array.from(codeDigest));
    });
  }

  public async storeRefreshToken(record: OAuthRefreshTokenRecord): Promise<void> {
    const tokenDigest = strictDigest(record.tokenDigest, 'tokenDigest');
    this.#validateRefreshRecord(record);
    const familyIdDigest = digestOpaqueId(record.familyId);
    const consentGrantId = idBuffer(record.consentGrantId ?? '', 'consentGrantId');
    await this.#withTransaction(async (connection) => {
      const grant = await this.#lockGrant(connection, consentGrantId);
      if (
        grant === null ||
        !this.#isActiveGrant(grant) ||
        grant.binding_id !== record.bindingId ||
        grant.client_id !== record.clientId ||
        grant.resource !== record.resource ||
        grant.scope !== record.scope
      ) {
        throw new OAuthPersistenceError('Refresh-token grant is unavailable');
      }
      await connection.execute(
        `INSERT INTO oauth_refresh_token_family
           (family_id_digest, family_id, client_id_digest, consent_grant_id, binding_id,
            resource, scope, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          familyIdDigest,
          record.familyId,
          digestOpaqueId(record.clientId),
          consentGrantId,
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
        `SELECT t.family_id_digest, f.family_id, f.consent_grant_id, c.client_id,
                f.binding_id, f.resource, f.scope, f.revoked_at AS family_revoked_at,
                t.expires_at, t.used_at, t.created_at,
                g.binding_id AS grant_binding_id, g.status AS grant_status,
                g.revoked_at AS grant_revoked_at,
                u.status AS account_status, m.status AS merchant_status,
                mm.status AS membership_status, e.status AS identity_status,
                e.revoked_at AS identity_revoked_at
           FROM oauth_refresh_token t
           JOIN oauth_refresh_token_family f ON f.family_id_digest = t.family_id_digest
           JOIN oauth_public_client c ON c.client_id_digest = f.client_id_digest
           JOIN connector_consent_grant g
             ON g.id = f.consent_grant_id
            AND g.client_id_digest = f.client_id_digest
            AND g.binding_id = f.binding_id AND g.resource = f.resource AND g.scope = f.scope
           JOIN merchant_user u ON u.id = g.merchant_user_id
           JOIN merchant m ON m.id = g.merchant_id
           JOIN merchant_membership mm
             ON mm.merchant_id = g.merchant_id AND mm.merchant_user_id = g.merchant_user_id
           JOIN external_identity e
             ON e.id = g.external_identity_id AND e.merchant_user_id = g.merchant_user_id
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
        row.grant_binding_id !== row.binding_id ||
        row.grant_status !== 'active' ||
        row.grant_revoked_at !== null ||
        row.account_status !== 'active' ||
        row.merchant_status !== 'active' ||
        row.membership_status !== 'active' ||
        row.identity_status !== 'active' ||
        row.identity_revoked_at !== null ||
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

  async #lockGrant(connection: Connection, grantId: Buffer): Promise<GrantContextRow | null> {
    const [rows] = await connection.execute<GrantContextRow[]>(
      `SELECT g.id, g.binding_id, c.client_id, g.resource, g.scope, g.status, g.revoked_at,
              g.authorization_transaction_digest, t.step AS transaction_step,
              t.consumed_at AS transaction_consumed_at,
              t.expires_at AS transaction_expires_at,
              t.redirect_uri AS transaction_redirect_uri,
              t.code_challenge AS transaction_code_challenge,
              u.status AS account_status, m.status AS merchant_status,
              mm.status AS membership_status, e.status AS identity_status,
              e.revoked_at AS identity_revoked_at
         FROM connector_consent_grant g
         JOIN connector_authorization_transaction t
           ON t.transaction_digest = g.authorization_transaction_digest
         JOIN oauth_public_client c ON c.client_id_digest = g.client_id_digest
         JOIN merchant_user u ON u.id = g.merchant_user_id
         JOIN merchant m ON m.id = g.merchant_id
         JOIN merchant_membership mm
           ON mm.merchant_id = g.merchant_id AND mm.merchant_user_id = g.merchant_user_id
         JOIN external_identity e
           ON e.id = g.external_identity_id AND e.merchant_user_id = g.merchant_user_id
        WHERE g.id = ?
        LIMIT 1
        FOR UPDATE`,
      [grantId],
    );
    return rows[0] ?? null;
  }

  #isActiveGrant(grant: GrantContextRow): boolean {
    return (
      grant.status === 'active' &&
      grant.revoked_at === null &&
      grant.account_status === 'active' &&
      grant.merchant_status === 'active' &&
      grant.membership_status === 'active' &&
      grant.identity_status === 'active' &&
      grant.identity_revoked_at === null
    );
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
