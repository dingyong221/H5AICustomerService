import { createHash, randomBytes } from 'node:crypto';

import type {
  ConnectorBindingResolution,
  ConnectorAuthorizationRepository,
  ConnectorAuthorizationStep,
  ConnectorAuthorizationTransaction,
  ConnectorConsentGrant,
  ExternalIdentityBindingRepository,
  ExternalIdentityBindingResult,
  MerchantId,
  MerchantUserId,
  OAuthAuthorizationCodeRecord,
  VerifiedExternalIdentity,
  WorkBuddyBindingStateRecord,
  WorkBuddyBindingStateRepository,
  WorkBuddyBindingStateToStore,
} from '@h5cs/domain';
import {
  ConnectorAuthorizationConflictError,
  connectorAuthorizationSteps,
  ExternalIdentityBindingConflictError,
  toExternalIdentityId,
  toMerchantId,
  toMerchantUserId,
} from '@h5cs/domain';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from './config.js';
import { probeDatabase } from './config.js';

type BridgeStateRow = RowDataPacket & {
  authorization_transaction_digest: Buffer;
  merchant_user_id: Buffer;
  login_session_digest: Buffer;
  configuration_id: string;
  configuration_version: number;
  expires_at: Date;
  consumed_at: Date | null;
};

type ExternalIdentityRow = RowDataPacket & {
  id: Buffer;
  merchant_user_id: Buffer;
  provider: string;
  issuer: string;
  audience: string;
  subject_lookup_key: Buffer;
  status: string;
  revoked_at: Date | null;
};

type AuthorizationTransactionRow = RowDataPacket & {
  transaction_digest: Buffer;
  login_session_digest: Buffer;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  code_challenge: string;
  connector_state_digest: Buffer;
  step: string;
  merchant_user_id: Buffer | null;
  external_identity_id: Buffer | null;
  merchant_id: Buffer | null;
  candidate_version: number;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ExistingGrantRow = RowDataPacket & {
  id: Buffer;
  binding_id: string;
  authorization_transaction_digest: Buffer;
  merchant_user_id: Buffer;
  external_identity_id: Buffer;
  merchant_id: Buffer;
  client_id: string;
  resource: string;
  scope: string;
  consent_version: string;
  status: string;
};

type BindingResolutionRow = RowDataPacket & {
  grant_id: Buffer;
  binding_id: string;
  merchant_user_id: Buffer;
  external_identity_id: Buffer;
  merchant_id: Buffer;
  client_id: string;
  resource: string;
  scope: string;
  provider: string;
  issuer: string;
  audience: string;
  subject_lookup_key: Buffer;
  subject_lookup_key_version: number;
  phone_match_verified_at: Date | null;
  last_seen_at: Date;
};

type MerchantCandidateRow = RowDataPacket & {
  merchant_id: Buffer;
  display_name: string;
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

const strictDigest = (value: Uint8Array, field: string): Buffer => {
  if (value.byteLength !== 32) {
    throw new IdentityAuthorizationPersistenceError(`${field} must contain exactly 32 bytes`);
  }
  return Buffer.from(value);
};

const opaqueDigest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

const bounded = (value: string, field: string, maximum: number): string => {
  if (value.length === 0 || value.length > maximum) {
    throw new IdentityAuthorizationPersistenceError(`${field} length is invalid`);
  }
  return value;
};

const validDate = (value: Date, field: string): Date => {
  if (!Number.isFinite(value.getTime())) {
    throw new IdentityAuthorizationPersistenceError(`${field} is invalid`);
  }
  return value;
};

const contextDigest = (grant: ConnectorConsentGrant): Buffer => {
  const hash = createHash('sha256');
  for (const value of [grant.merchantUserId, grant.clientId, grant.resource, grant.scope]) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length).update(bytes);
  }
  return hash.digest();
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));

const isDuplicateKey = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown };
  return candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062;
};

const toAuthorizationStep = (value: string): ConnectorAuthorizationStep => {
  const step = connectorAuthorizationSteps.find((candidate) => candidate === value);
  if (step === undefined) {
    throw new IdentityAuthorizationPersistenceError(
      'Stored connector authorization step is invalid',
    );
  }
  return step;
};

const toConnectorScope = (value: string): 'mcp:tools' => {
  if (value !== 'mcp:tools') {
    throw new IdentityAuthorizationPersistenceError('Stored connector scope is invalid');
  }
  return value;
};

const rowToAuthorization = (
  row: AuthorizationTransactionRow,
): ConnectorAuthorizationTransaction => ({
  transactionDigest: Uint8Array.from(row.transaction_digest),
  loginSessionDigest: Uint8Array.from(row.login_session_digest),
  clientId: row.client_id,
  redirectUri: row.redirect_uri,
  resource: row.resource,
  scope: toConnectorScope(row.scope),
  codeChallenge: row.code_challenge,
  connectorStateDigest: Uint8Array.from(row.connector_state_digest),
  step: toAuthorizationStep(row.step),
  merchantUserId:
    row.merchant_user_id === null
      ? null
      : toMerchantUserId(idString(row.merchant_user_id, 'merchantUserId')),
  externalIdentityId:
    row.external_identity_id === null
      ? null
      : toExternalIdentityId(idString(row.external_identity_id, 'externalIdentityId')),
  merchantId:
    row.merchant_id === null ? null : toMerchantId(idString(row.merchant_id, 'merchantId')),
  candidateVersion: row.candidate_version,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class IdentityAuthorizationPersistenceError extends Error {
  public constructor(message = 'Identity authorization persistence is unavailable') {
    super(message);
    this.name = 'IdentityAuthorizationPersistenceError';
  }
}

export class MySqlIdentityAuthorizationRepository
  implements
    WorkBuddyBindingStateRepository,
    ExternalIdentityBindingRepository,
    ConnectorAuthorizationRepository
{
  readonly #config: DatabaseConnectionConfig;

  public constructor(config: DatabaseConnectionConfig) {
    this.#config = config;
  }

  public async assertReady(): Promise<void> {
    const probe = await probeDatabase(this.#config);
    if (!probe.ok) throw new IdentityAuthorizationPersistenceError();
  }

  public async store(record: WorkBuddyBindingStateToStore): Promise<void> {
    const stateDigest = strictDigest(record.stateDigest, 'stateDigest');
    const sessionDigest = strictDigest(record.loginSessionDigest, 'loginSessionDigest');
    if (!/^[0-9a-f]{64}$/iu.test(record.transactionId)) {
      throw new IdentityAuthorizationPersistenceError('transactionId must be a digest reference');
    }
    const authorizationDigest = strictDigest(
      Buffer.from(record.transactionId, 'hex'),
      'transactionId',
    );
    bounded(record.configurationId, 'configurationId', 128);
    if (!Number.isSafeInteger(record.configurationVersion) || record.configurationVersion < 1) {
      throw new IdentityAuthorizationPersistenceError('configurationVersion is invalid');
    }
    validDate(record.expiresAt, 'expiresAt');
    validDate(record.createdAt, 'createdAt');
    if (record.expiresAt.getTime() <= record.createdAt.getTime()) {
      throw new IdentityAuthorizationPersistenceError('Bridge state expiry must follow creation');
    }

    await this.#withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO workbuddy_bridge_state
           (state_digest, authorization_transaction_digest, merchant_user_id,
            login_session_digest, configuration_id, configuration_version,
            expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          stateDigest,
          authorizationDigest,
          idBuffer(record.merchantUserId, 'merchantUserId'),
          sessionDigest,
          record.configurationId,
          record.configurationVersion,
          record.expiresAt,
          record.createdAt,
        ],
      );
    });
  }

  public async consume(
    stateDigestValue: Uint8Array,
    loginSessionDigestValue: Uint8Array,
    now: Date,
  ): Promise<WorkBuddyBindingStateRecord | null> {
    const stateDigest = strictDigest(stateDigestValue, 'stateDigest');
    const loginSessionDigest = strictDigest(loginSessionDigestValue, 'loginSessionDigest');
    validDate(now, 'now');
    return this.#withTransaction(async (connection) => {
      const [rows] = await connection.execute<BridgeStateRow[]>(
        `SELECT authorization_transaction_digest, merchant_user_id, login_session_digest,
                configuration_id, configuration_version, expires_at, consumed_at
           FROM workbuddy_bridge_state
          WHERE state_digest = ? AND login_session_digest = ?
          LIMIT 1
          FOR UPDATE`,
        [stateDigest, loginSessionDigest],
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
        `UPDATE workbuddy_bridge_state
            SET consumed_at = ?
          WHERE state_digest = ? AND consumed_at IS NULL`,
        [now, stateDigest],
      );
      if (result.affectedRows !== 1) return null;
      return {
        transactionId: row.authorization_transaction_digest.toString('hex'),
        merchantUserId: toMerchantUserId(idString(row.merchant_user_id, 'merchantUserId')),
        loginSessionDigest: Uint8Array.from(row.login_session_digest),
        configurationId: row.configuration_id,
        configurationVersion: row.configuration_version,
        expiresAt: row.expires_at,
      };
    });
  }

  public async bind(
    merchantUserId: MerchantUserId,
    identity: VerifiedExternalIdentity,
  ): Promise<ExternalIdentityBindingResult> {
    this.#validateIdentity(identity);
    const userId = idBuffer(merchantUserId, 'merchantUserId');
    try {
      return await this.#withTransaction((connection) =>
        this.#bindIdentity(connection, merchantUserId, userId, identity),
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const rows = await this.#withConnection((connection) =>
        this.#findIdentityRows(connection, userId, identity, false),
      );
      const exact = rows.find(
        (row) =>
          idString(row.merchant_user_id, 'merchantUserId') === merchantUserId &&
          row.status === 'active' &&
          row.revoked_at === null &&
          sameBytes(row.subject_lookup_key, identity.subjectLookupKey),
      );
      if (exact !== undefined) {
        return {
          status: 'idempotent',
          externalIdentityId: toExternalIdentityId(idString(exact.id, 'externalIdentityId')),
        };
      }
      throw new ExternalIdentityBindingConflictError();
    }
  }

  public async storeAuthorizationTransaction(
    record: ConnectorAuthorizationTransaction,
  ): Promise<void> {
    this.#validateAuthorization(record);
    await this.#withConnection(async (connection) => {
      await connection.execute(
        `INSERT INTO connector_authorization_transaction
           (transaction_digest, login_session_digest, client_id_digest, redirect_uri,
            resource, resource_digest, scope, code_challenge, connector_state_digest,
            step, merchant_user_id, external_identity_id, merchant_id,
            candidate_version, expires_at,
            consumed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          Buffer.from(record.transactionDigest),
          Buffer.from(record.loginSessionDigest),
          opaqueDigest(record.clientId),
          record.redirectUri,
          record.resource,
          opaqueDigest(record.resource),
          record.scope,
          record.codeChallenge,
          Buffer.from(record.connectorStateDigest),
          record.step,
          record.merchantUserId === null ? null : idBuffer(record.merchantUserId, 'merchantUserId'),
          record.externalIdentityId === null
            ? null
            : idBuffer(record.externalIdentityId, 'externalIdentityId'),
          record.merchantId === null ? null : idBuffer(record.merchantId, 'merchantId'),
          record.candidateVersion,
          record.expiresAt,
          record.createdAt,
          record.updatedAt,
        ],
      );
    });
  }

  public async acceptExternalIdentity(input: {
    transactionDigest: Uint8Array;
    loginSessionDigest: Uint8Array;
    merchantUserId: MerchantUserId;
    identity: VerifiedExternalIdentity;
    now: Date;
  }): Promise<
    Readonly<{
      transaction: ConnectorAuthorizationTransaction;
      binding: ExternalIdentityBindingResult;
    }>
  > {
    const transactionDigest = strictDigest(input.transactionDigest, 'transactionDigest');
    const loginSessionDigest = strictDigest(input.loginSessionDigest, 'loginSessionDigest');
    const userId = idBuffer(input.merchantUserId, 'merchantUserId');
    this.#validateIdentity(input.identity);
    validDate(input.now, 'now');
    try {
      return await this.#withTransaction(async (connection) => {
        const authorization = await this.#lockAuthorization(
          connection,
          transactionDigest,
          loginSessionDigest,
          input.now,
        );
        if (
          authorization === null ||
          authorization.step !== 'binding_required' ||
          authorization.merchant_user_id === null ||
          idString(authorization.merchant_user_id, 'merchantUserId') !== input.merchantUserId
        ) {
          throw new ConnectorAuthorizationConflictError();
        }
        const binding = await this.#bindIdentity(
          connection,
          input.merchantUserId,
          userId,
          input.identity,
        );
        const identityId = idBuffer(binding.externalIdentityId, 'externalIdentityId');
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE connector_authorization_transaction
              SET external_identity_id = ?, step = 'merchant_selection_required', updated_at = ?
            WHERE transaction_digest = ? AND login_session_digest = ?
              AND step = 'binding_required' AND consumed_at IS NULL`,
          [identityId, input.now, transactionDigest, loginSessionDigest],
        );
        if (result.affectedRows !== 1) throw new ConnectorAuthorizationConflictError();
        return {
          binding,
          transaction: {
            ...rowToAuthorization(authorization),
            externalIdentityId: binding.externalIdentityId,
            step: 'merchant_selection_required',
            updatedAt: input.now,
          },
        };
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new ExternalIdentityBindingConflictError();
      throw error;
    }
  }

  public async listActiveMerchantCandidates(
    transactionDigestValue: Uint8Array,
    loginSessionDigestValue: Uint8Array,
    now: Date,
  ): Promise<Readonly<{
    candidateVersion: number;
    candidates: readonly Readonly<{ merchantId: MerchantId; displayName: string }>[];
  }> | null> {
    const transactionDigest = strictDigest(transactionDigestValue, 'transactionDigest');
    const loginSessionDigest = strictDigest(loginSessionDigestValue, 'loginSessionDigest');
    validDate(now, 'now');
    return this.#withTransaction(async (connection) => {
      const authorization = await this.#lockAuthorization(
        connection,
        transactionDigest,
        loginSessionDigest,
        now,
      );
      if (
        authorization === null ||
        authorization.merchant_user_id === null ||
        authorization.external_identity_id === null ||
        (authorization.step !== 'merchant_selection_required' &&
          authorization.step !== 'consent_required')
      ) {
        return null;
      }
      const [identities] = await connection.execute<RowDataPacket[]>(
        `SELECT id
           FROM external_identity
          WHERE id = ? AND merchant_user_id = ? AND status = 'active' AND revoked_at IS NULL
          LIMIT 1
          FOR UPDATE`,
        [authorization.external_identity_id, authorization.merchant_user_id],
      );
      if (identities[0] === undefined) return null;
      const [rows] = await connection.execute<MerchantCandidateRow[]>(
        `SELECT m.id AS merchant_id, m.display_name
           FROM merchant_membership mm
           JOIN merchant m ON m.id = mm.merchant_id
          WHERE mm.merchant_user_id = ? AND mm.status = 'active' AND m.status = 'active'
          ORDER BY m.created_at ASC, m.id ASC
          FOR UPDATE`,
        [authorization.merchant_user_id],
      );
      return {
        candidateVersion: authorization.candidate_version,
        candidates: rows.map((row) => ({
          merchantId: toMerchantId(idString(row.merchant_id, 'merchantId')),
          displayName: row.display_name,
        })),
      };
    });
  }

  public async selectMerchantForAuthorization(input: {
    transactionDigest: Uint8Array;
    loginSessionDigest: Uint8Array;
    merchantId: MerchantId;
    expectedCandidateVersion: number;
    now: Date;
  }): Promise<ConnectorAuthorizationTransaction | null> {
    const transactionDigest = strictDigest(input.transactionDigest, 'transactionDigest');
    const loginSessionDigest = strictDigest(input.loginSessionDigest, 'loginSessionDigest');
    const merchantId = idBuffer(input.merchantId, 'merchantId');
    if (
      !Number.isSafeInteger(input.expectedCandidateVersion) ||
      input.expectedCandidateVersion < 0
    ) {
      throw new IdentityAuthorizationPersistenceError('expectedCandidateVersion is invalid');
    }
    validDate(input.now, 'now');
    return this.#withTransaction(async (connection) => {
      const authorization = await this.#lockAuthorization(
        connection,
        transactionDigest,
        loginSessionDigest,
        input.now,
      );
      if (
        authorization === null ||
        authorization.merchant_user_id === null ||
        authorization.external_identity_id === null ||
        authorization.candidate_version !== input.expectedCandidateVersion ||
        (authorization.step !== 'merchant_selection_required' &&
          authorization.step !== 'consent_required')
      ) {
        return null;
      }
      const [memberships] = await connection.execute<RowDataPacket[]>(
        `SELECT mm.merchant_id
           FROM merchant_membership mm
           JOIN merchant m ON m.id = mm.merchant_id
          WHERE mm.merchant_id = ? AND mm.merchant_user_id = ?
            AND mm.status = 'active' AND m.status = 'active'
          LIMIT 1
          FOR UPDATE`,
        [merchantId, authorization.merchant_user_id],
      );
      if (memberships[0] === undefined) return null;
      const nextVersion = input.expectedCandidateVersion + 1;
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE connector_authorization_transaction
            SET merchant_id = ?, step = 'consent_required', candidate_version = ?, updated_at = ?
          WHERE transaction_digest = ? AND login_session_digest = ?
            AND candidate_version = ? AND consumed_at IS NULL`,
        [
          merchantId,
          nextVersion,
          input.now,
          transactionDigest,
          loginSessionDigest,
          input.expectedCandidateVersion,
        ],
      );
      if (result.affectedRows !== 1) return null;
      return {
        ...rowToAuthorization(authorization),
        merchantId: input.merchantId,
        candidateVersion: nextVersion,
        step: 'consent_required',
        updatedAt: input.now,
      };
    });
  }

  public async consumeAuthorizationTransaction(
    transactionDigestValue: Uint8Array,
    loginSessionDigestValue: Uint8Array,
    now: Date,
  ): Promise<ConnectorAuthorizationTransaction | null> {
    const transactionDigest = strictDigest(transactionDigestValue, 'transactionDigest');
    const loginSessionDigest = strictDigest(loginSessionDigestValue, 'loginSessionDigest');
    validDate(now, 'now');
    return this.#withTransaction(async (connection) => {
      const [rows] = await connection.execute<AuthorizationTransactionRow[]>(
        `SELECT a.transaction_digest, a.login_session_digest, c.client_id, a.redirect_uri,
                a.resource, a.scope, a.code_challenge, a.connector_state_digest, a.step,
                a.merchant_user_id, a.external_identity_id, a.merchant_id,
                a.candidate_version, a.expires_at,
                a.consumed_at, a.created_at, a.updated_at
           FROM connector_authorization_transaction a
           JOIN oauth_public_client c ON c.client_id_digest = a.client_id_digest
          WHERE a.transaction_digest = ? AND a.login_session_digest = ?
          LIMIT 1
          FOR UPDATE`,
        [transactionDigest, loginSessionDigest],
      );
      const row = rows[0];
      if (
        row === undefined ||
        row.consumed_at !== null ||
        row.expires_at.getTime() <= now.getTime()
      ) {
        return null;
      }
      const snapshot = rowToAuthorization(row);
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE connector_authorization_transaction
            SET step = 'consumed', consumed_at = ?, updated_at = ?
          WHERE transaction_digest = ? AND consumed_at IS NULL`,
        [now, now, transactionDigest],
      );
      if (result.affectedRows !== 1) return null;
      return snapshot;
    });
  }

  public async activateConsentGrant(
    grant: ConnectorConsentGrant,
    now: Date,
  ): Promise<Readonly<{ replacedGrantIds: readonly string[] }>> {
    return this.#activateConsentGrant(grant, now);
  }

  public async approveConsentAndIssueAuthorizationCode(
    grant: ConnectorConsentGrant,
    code: OAuthAuthorizationCodeRecord,
    now: Date,
  ): Promise<Readonly<{ replacedGrantIds: readonly string[] }>> {
    const codeDigest = strictDigest(code.codeDigest, 'codeDigest');
    const consentGrantId = idBuffer(code.consentGrantId ?? '', 'consentGrantId');
    bounded(code.clientId, 'code.clientId', 128);
    bounded(code.redirectUri, 'code.redirectUri', 2_048);
    bounded(code.resource, 'code.resource', 2_048);
    bounded(code.codeChallenge, 'code.codeChallenge', 128);
    bounded(code.bindingId, 'code.bindingId', 191);
    validDate(code.createdAt, 'code.createdAt');
    validDate(code.expiresAt, 'code.expiresAt');
    if (
      !consentGrantId.equals(idBuffer(grant.grantId, 'grantId')) ||
      code.bindingId !== grant.bindingId ||
      code.clientId !== grant.clientId ||
      code.resource !== grant.resource ||
      code.scope !== grant.scope ||
      code.expiresAt.getTime() <= code.createdAt.getTime()
    ) {
      throw new IdentityAuthorizationPersistenceError(
        'Authorization code does not match the consent grant',
      );
    }
    return this.#activateConsentGrant(grant, now, {
      requireNewGrant: true,
      afterActivate: async (connection, authorization) => {
        if (
          code.redirectUri !== authorization.redirect_uri ||
          code.codeChallenge !== authorization.code_challenge ||
          code.createdAt.getTime() < now.getTime() ||
          code.expiresAt.getTime() > authorization.expires_at.getTime()
        ) {
          throw new ConnectorAuthorizationConflictError();
        }
        await connection.execute(
          `INSERT INTO oauth_authorization_code
             (code_digest, client_id_digest, consent_grant_id, redirect_uri, resource, scope,
              code_challenge, binding_id, expires_at, consumed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          [
            codeDigest,
            opaqueDigest(code.clientId),
            consentGrantId,
            code.redirectUri,
            code.resource,
            code.scope,
            code.codeChallenge,
            code.bindingId,
            code.expiresAt,
            code.createdAt,
          ],
        );
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE connector_authorization_transaction
              SET step = 'code_issued', updated_at = ?
            WHERE transaction_digest = ? AND step = 'approved' AND consumed_at IS NULL`,
          [code.createdAt, Buffer.from(grant.authorizationTransactionDigest)],
        );
        if (result.affectedRows !== 1) throw new ConnectorAuthorizationConflictError();
      },
    });
  }

  async #activateConsentGrant(
    grant: ConnectorConsentGrant,
    now: Date,
    options?: Readonly<{
      requireNewGrant: boolean;
      afterActivate: (
        connection: Connection,
        authorization: AuthorizationTransactionRow,
      ) => Promise<void>;
    }>,
  ): Promise<Readonly<{ replacedGrantIds: readonly string[] }>> {
    this.#validateGrant(grant);
    validDate(now, 'now');
    const transactionDigest = strictDigest(
      grant.authorizationTransactionDigest,
      'authorizationTransactionDigest',
    );
    const activeKeyDigest = contextDigest(grant);
    const grantId = idBuffer(grant.grantId, 'grantId');

    try {
      return await this.#withTransaction(async (connection) => {
        const [authorizationRows] = await connection.execute<AuthorizationTransactionRow[]>(
          `SELECT a.transaction_digest, a.login_session_digest, c.client_id, a.redirect_uri,
                a.resource, a.scope, a.code_challenge, a.connector_state_digest, a.step,
                a.merchant_user_id, a.external_identity_id, a.merchant_id,
                a.candidate_version, a.expires_at,
                a.consumed_at, a.created_at, a.updated_at
           FROM connector_authorization_transaction a
           JOIN oauth_public_client c ON c.client_id_digest = a.client_id_digest
           JOIN platform_login_session s
             ON s.session_digest = a.login_session_digest
            AND s.merchant_user_id = a.merchant_user_id
           JOIN merchant_user u ON u.id = a.merchant_user_id
          WHERE a.transaction_digest = ? AND s.revoked_at IS NULL AND s.expires_at > ?
            AND u.status = 'active'
          LIMIT 1
          FOR UPDATE`,
          [transactionDigest, now],
        );
        const authorization = authorizationRows[0];
        if (
          authorization === undefined ||
          authorization.consumed_at !== null ||
          authorization.expires_at.getTime() <= now.getTime() ||
          (authorization.step !== 'consent_required' && authorization.step !== 'approved') ||
          authorization.merchant_user_id === null ||
          authorization.external_identity_id === null ||
          authorization.merchant_id === null ||
          idString(authorization.merchant_user_id, 'merchantUserId') !== grant.merchantUserId ||
          idString(authorization.external_identity_id, 'externalIdentityId') !==
            grant.externalIdentityId ||
          idString(authorization.merchant_id, 'merchantId') !== grant.merchantId ||
          authorization.client_id !== grant.clientId ||
          authorization.resource !== grant.resource ||
          authorization.scope !== grant.scope
        ) {
          throw new ConnectorAuthorizationConflictError();
        }

        const [identities] = await connection.execute<RowDataPacket[]>(
          `SELECT id
             FROM external_identity
            WHERE id = ? AND merchant_user_id = ? AND status = 'active' AND revoked_at IS NULL
            LIMIT 1
            FOR UPDATE`,
          [
            idBuffer(grant.externalIdentityId, 'externalIdentityId'),
            idBuffer(grant.merchantUserId, 'merchantUserId'),
          ],
        );
        if (identities[0] === undefined) throw new ConnectorAuthorizationConflictError();

        const [memberships] = await connection.execute<RowDataPacket[]>(
          `SELECT mm.merchant_id
           FROM merchant_membership mm
           JOIN merchant m ON m.id = mm.merchant_id
          WHERE mm.merchant_id = ? AND mm.merchant_user_id = ?
            AND mm.status = 'active' AND m.status = 'active'
          LIMIT 1
          FOR UPDATE`,
          [
            idBuffer(grant.merchantId, 'merchantId'),
            idBuffer(grant.merchantUserId, 'merchantUserId'),
          ],
        );
        if (memberships[0] === undefined) throw new ConnectorAuthorizationConflictError();

        const [existingRows] = await connection.execute<ExistingGrantRow[]>(
          `SELECT g.id, g.binding_id, g.authorization_transaction_digest, g.merchant_user_id,
                g.external_identity_id, g.merchant_id, c.client_id, g.resource, g.scope,
                g.consent_version, g.status
           FROM connector_consent_grant g
           JOIN oauth_public_client c ON c.client_id_digest = g.client_id_digest
          WHERE g.authorization_transaction_digest = ? OR g.active_key_digest = ?
          FOR UPDATE`,
          [transactionDigest, activeKeyDigest],
        );
        const sameTransaction = existingRows.find((row) =>
          row.authorization_transaction_digest.equals(transactionDigest),
        );
        if (sameTransaction !== undefined) {
          if (
            sameTransaction.id.equals(grantId) &&
            sameTransaction.binding_id === grant.bindingId &&
            sameTransaction.status === 'active' &&
            authorization.step === 'approved' &&
            idString(sameTransaction.merchant_user_id, 'merchantUserId') === grant.merchantUserId &&
            idString(sameTransaction.external_identity_id, 'externalIdentityId') ===
              grant.externalIdentityId &&
            idString(sameTransaction.merchant_id, 'merchantId') === grant.merchantId &&
            sameTransaction.client_id === grant.clientId &&
            sameTransaction.resource === grant.resource &&
            sameTransaction.scope === grant.scope &&
            sameTransaction.consent_version === grant.consentVersion
          ) {
            if (options?.requireNewGrant === true) {
              throw new ConnectorAuthorizationConflictError();
            }
            return { replacedGrantIds: [] };
          }
          throw new ConnectorAuthorizationConflictError();
        }

        if (authorization.step !== 'consent_required') {
          throw new ConnectorAuthorizationConflictError();
        }

        const replaced = existingRows.filter((row) => row.status === 'active');
        if (replaced.length > 0) {
          const placeholders = replaced.map(() => '?').join(', ');
          const ids = replaced.map((row) => row.id);
          await connection.execute(
            `UPDATE connector_consent_grant
              SET status = 'revoked', active_key_digest = NULL, revoked_at = ?,
                  updated_at = UTC_TIMESTAMP(6)
            WHERE id IN (${placeholders}) AND status = 'active'`,
            [now, ...ids],
          );
          await connection.execute(
            `UPDATE oauth_refresh_token_family
              SET revoked_at = COALESCE(revoked_at, ?)
            WHERE consent_grant_id IN (${placeholders})`,
            [now, ...ids],
          );
        }

        await connection.execute(
          `INSERT INTO connector_consent_grant
           (id, binding_id_digest, binding_id, active_key_digest,
            authorization_transaction_digest, merchant_user_id, external_identity_id, merchant_id,
            client_id_digest, resource, resource_digest, scope, consent_version,
            status, granted_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL,
                 UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
          [
            grantId,
            opaqueDigest(grant.bindingId),
            grant.bindingId,
            activeKeyDigest,
            transactionDigest,
            idBuffer(grant.merchantUserId, 'merchantUserId'),
            idBuffer(grant.externalIdentityId, 'externalIdentityId'),
            idBuffer(grant.merchantId, 'merchantId'),
            opaqueDigest(grant.clientId),
            grant.resource,
            opaqueDigest(grant.resource),
            grant.scope,
            grant.consentVersion,
            grant.grantedAt,
          ],
        );
        const [authorizationResult] = await connection.execute<ResultSetHeader>(
          `UPDATE connector_authorization_transaction
              SET step = 'approved', updated_at = ?
            WHERE transaction_digest = ? AND step = 'consent_required'
              AND consumed_at IS NULL`,
          [now, transactionDigest],
        );
        if (authorizationResult.affectedRows !== 1) {
          throw new ConnectorAuthorizationConflictError();
        }
        await options?.afterActivate(connection, authorization);
        return {
          replacedGrantIds: replaced.map((row) => idString(row.id, 'grantId')),
        };
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new ConnectorAuthorizationConflictError();
      throw error;
    }
  }

  public async resolveActiveBinding(
    bindingId: string,
    now: Date,
  ): Promise<ConnectorBindingResolution | null> {
    bounded(bindingId, 'bindingId', 191);
    validDate(now, 'now');
    return this.#withConnection(async (connection) => {
      const [rows] = await connection.execute<BindingResolutionRow[]>(
        `SELECT g.id AS grant_id, g.binding_id, g.merchant_user_id,
                g.external_identity_id, g.merchant_id, c.client_id, g.resource, g.scope,
                e.provider, e.issuer, e.audience, e.subject_lookup_key,
                e.subject_lookup_key_version, e.phone_match_verified_at, e.last_seen_at
           FROM connector_consent_grant g
           JOIN oauth_public_client c ON c.client_id_digest = g.client_id_digest
           JOIN merchant_user u ON u.id = g.merchant_user_id
           JOIN merchant m ON m.id = g.merchant_id
           JOIN merchant_membership mm
             ON mm.merchant_id = g.merchant_id AND mm.merchant_user_id = g.merchant_user_id
           JOIN external_identity e
             ON e.id = g.external_identity_id AND e.merchant_user_id = g.merchant_user_id
          WHERE g.binding_id_digest = ? AND g.binding_id = ?
            AND g.status = 'active' AND g.revoked_at IS NULL
            AND u.status = 'active' AND m.status = 'active' AND mm.status = 'active'
            AND e.status = 'active' AND e.revoked_at IS NULL
          LIMIT 2`,
        [opaqueDigest(bindingId), bindingId],
      );
      if (rows.length !== 1) return null;
      const row = rows[0];
      if (row === undefined || row.provider !== 'workbuddy' || row.scope !== 'mcp:tools') {
        return null;
      }
      return {
        grantId: idString(row.grant_id, 'grantId'),
        bindingId: row.binding_id,
        merchantUserId: toMerchantUserId(idString(row.merchant_user_id, 'merchantUserId')),
        externalIdentityId: toExternalIdentityId(
          idString(row.external_identity_id, 'externalIdentityId'),
        ),
        merchantId: toMerchantId(idString(row.merchant_id, 'merchantId')),
        clientId: row.client_id,
        resource: row.resource,
        scope: 'mcp:tools',
        identity: {
          provider: 'workbuddy',
          issuer: row.issuer,
          audience: row.audience,
          subjectLookupKey: Uint8Array.from(row.subject_lookup_key),
          subjectLookupKeyVersion: row.subject_lookup_key_version,
          phoneMatchVerifiedAt: row.phone_match_verified_at,
          verifiedAt: row.last_seen_at,
        },
      };
    });
  }

  public async revokeConsentGrant(bindingId: string, now: Date): Promise<boolean> {
    bounded(bindingId, 'bindingId', 191);
    validDate(now, 'now');
    return this.#withTransaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT id, status
           FROM connector_consent_grant
          WHERE binding_id_digest = ? AND binding_id = ?
          LIMIT 1
          FOR UPDATE`,
        [opaqueDigest(bindingId), bindingId],
      );
      const row = rows[0] as (RowDataPacket & { id: Buffer; status: string }) | undefined;
      if (row === undefined || row.status !== 'active') return false;
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE connector_consent_grant
            SET status = 'revoked', active_key_digest = NULL, revoked_at = ?,
                updated_at = UTC_TIMESTAMP(6)
          WHERE id = ? AND status = 'active'`,
        [now, row.id],
      );
      if (result.affectedRows !== 1) throw new ConnectorAuthorizationConflictError();
      await connection.execute(
        `UPDATE oauth_refresh_token_family
            SET revoked_at = COALESCE(revoked_at, ?)
          WHERE consent_grant_id = ?`,
        [now, row.id],
      );
      return true;
    });
  }

  async #lockAuthorization(
    connection: Connection,
    transactionDigest: Buffer,
    loginSessionDigest: Buffer,
    now: Date,
  ): Promise<AuthorizationTransactionRow | null> {
    const [rows] = await connection.execute<AuthorizationTransactionRow[]>(
      `SELECT a.transaction_digest, a.login_session_digest, c.client_id, a.redirect_uri,
              a.resource, a.scope, a.code_challenge, a.connector_state_digest, a.step,
              a.merchant_user_id, a.external_identity_id, a.merchant_id,
              a.candidate_version, a.expires_at, a.consumed_at, a.created_at, a.updated_at
         FROM connector_authorization_transaction a
         JOIN oauth_public_client c ON c.client_id_digest = a.client_id_digest
         JOIN platform_login_session s
           ON s.session_digest = a.login_session_digest
          AND s.merchant_user_id = a.merchant_user_id
         JOIN merchant_user u ON u.id = a.merchant_user_id
        WHERE a.transaction_digest = ? AND a.login_session_digest = ?
          AND a.consumed_at IS NULL AND a.expires_at > ?
          AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'
        LIMIT 1
        FOR UPDATE`,
      [transactionDigest, loginSessionDigest, now, now],
    );
    return rows[0] ?? null;
  }

  async #bindIdentity(
    connection: Connection,
    merchantUserId: MerchantUserId,
    userId: Buffer,
    identity: VerifiedExternalIdentity,
  ): Promise<ExternalIdentityBindingResult> {
    const rows = await this.#findIdentityRows(connection, userId, identity, true);
    if (rows.length > 0) {
      const exact = rows.find(
        (row) =>
          idString(row.merchant_user_id, 'merchantUserId') === merchantUserId &&
          row.provider === identity.provider &&
          row.issuer === identity.issuer &&
          row.audience === identity.audience &&
          sameBytes(row.subject_lookup_key, identity.subjectLookupKey),
      );
      if (exact === undefined || exact.status !== 'active' || exact.revoked_at !== null) {
        throw new ExternalIdentityBindingConflictError();
      }
      await connection.execute(
        `UPDATE external_identity
            SET last_seen_at = ?, phone_match_verified_at = COALESCE(?, phone_match_verified_at),
                subject_lookup_key_version = ?, updated_at = UTC_TIMESTAMP(6)
          WHERE id = ? AND status = 'active'`,
        [
          identity.verifiedAt,
          identity.phoneMatchVerifiedAt,
          identity.subjectLookupKeyVersion,
          exact.id,
        ],
      );
      return {
        status: 'idempotent',
        externalIdentityId: toExternalIdentityId(idString(exact.id, 'externalIdentityId')),
      };
    }

    const externalIdentityId = randomBytes(16);
    await connection.execute(
      `INSERT INTO external_identity
         (id, merchant_user_id, provider, issuer, audience, subject_lookup_key,
          subject_lookup_key_version, status, phone_match_verified_at, bound_at,
          unlink_requested_at, revoked_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?,
               UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))`,
      [
        externalIdentityId,
        userId,
        identity.provider,
        identity.issuer,
        identity.audience,
        Buffer.from(identity.subjectLookupKey),
        identity.subjectLookupKeyVersion,
        identity.phoneMatchVerifiedAt,
        identity.verifiedAt,
        identity.verifiedAt,
      ],
    );
    return {
      status: 'created',
      externalIdentityId: toExternalIdentityId(idString(externalIdentityId, 'externalIdentityId')),
    };
  }

  async #findIdentityRows(
    connection: Connection,
    merchantUserId: Buffer,
    identity: VerifiedExternalIdentity,
    lock: boolean,
  ): Promise<ExternalIdentityRow[]> {
    const [rows] = await connection.execute<ExternalIdentityRow[]>(
      `SELECT id, merchant_user_id, provider, issuer, audience, subject_lookup_key, status,
              revoked_at
         FROM external_identity
        WHERE (provider = ? AND issuer = ? AND audience = ? AND subject_lookup_key = ?)
           OR (merchant_user_id = ? AND provider = ? AND issuer = ? AND audience = ?)
        ORDER BY id ASC
        ${lock ? 'FOR UPDATE' : ''}`,
      [
        identity.provider,
        identity.issuer,
        identity.audience,
        Buffer.from(identity.subjectLookupKey),
        merchantUserId,
        identity.provider,
        identity.issuer,
        identity.audience,
      ],
    );
    return rows;
  }

  #validateIdentity(identity: VerifiedExternalIdentity): void {
    if (identity.provider !== 'workbuddy') {
      throw new IdentityAuthorizationPersistenceError('identity provider is invalid');
    }
    bounded(identity.issuer, 'issuer', 255);
    bounded(identity.audience, 'audience', 191);
    strictDigest(identity.subjectLookupKey, 'subjectLookupKey');
    if (
      !Number.isSafeInteger(identity.subjectLookupKeyVersion) ||
      identity.subjectLookupKeyVersion < 1
    ) {
      throw new IdentityAuthorizationPersistenceError('subjectLookupKeyVersion is invalid');
    }
    validDate(identity.verifiedAt, 'verifiedAt');
    if (identity.phoneMatchVerifiedAt !== null) {
      validDate(identity.phoneMatchVerifiedAt, 'phoneMatchVerifiedAt');
    }
  }

  #validateAuthorization(record: ConnectorAuthorizationTransaction): void {
    strictDigest(record.transactionDigest, 'transactionDigest');
    strictDigest(record.loginSessionDigest, 'loginSessionDigest');
    strictDigest(record.connectorStateDigest, 'connectorStateDigest');
    bounded(record.clientId, 'clientId', 128);
    bounded(record.redirectUri, 'redirectUri', 2_048);
    bounded(record.resource, 'resource', 2_048);
    if (record.scope !== 'mcp:tools') {
      throw new IdentityAuthorizationPersistenceError('scope is invalid');
    }
    bounded(record.codeChallenge, 'codeChallenge', 128);
    if (!connectorAuthorizationSteps.includes(record.step)) {
      throw new IdentityAuthorizationPersistenceError('step is invalid');
    }
    if (!Number.isSafeInteger(record.candidateVersion) || record.candidateVersion < 0) {
      throw new IdentityAuthorizationPersistenceError('candidateVersion is invalid');
    }
    if (record.externalIdentityId !== null && record.merchantUserId === null) {
      throw new IdentityAuthorizationPersistenceError('externalIdentityId requires merchantUserId');
    }
    validDate(record.expiresAt, 'expiresAt');
    validDate(record.createdAt, 'createdAt');
    validDate(record.updatedAt, 'updatedAt');
    if (record.expiresAt.getTime() <= record.createdAt.getTime()) {
      throw new IdentityAuthorizationPersistenceError('Authorization expiry must follow creation');
    }
  }

  #validateGrant(grant: ConnectorConsentGrant): void {
    idBuffer(grant.grantId, 'grantId');
    bounded(grant.bindingId, 'bindingId', 191);
    strictDigest(grant.authorizationTransactionDigest, 'authorizationTransactionDigest');
    idBuffer(grant.merchantUserId, 'merchantUserId');
    idBuffer(grant.externalIdentityId, 'externalIdentityId');
    idBuffer(grant.merchantId, 'merchantId');
    bounded(grant.clientId, 'clientId', 128);
    bounded(grant.resource, 'resource', 2_048);
    if (grant.scope !== 'mcp:tools' || grant.status !== 'active' || grant.revokedAt !== null) {
      throw new IdentityAuthorizationPersistenceError('Consent grant state is invalid');
    }
    bounded(grant.consentVersion, 'consentVersion', 64);
    validDate(grant.grantedAt, 'grantedAt');
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
