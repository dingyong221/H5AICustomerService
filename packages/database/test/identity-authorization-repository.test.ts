import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  ConnectorAuthorizationTransaction,
  ConnectorConsentGrant,
  VerifiedExternalIdentity,
  WorkBuddyBindingStateToStore,
} from '@h5cs/domain';
import {
  ConnectorAuthorizationConflictError,
  ExternalIdentityBindingConflictError,
  toMerchantId,
  toMerchantUserId,
} from '@h5cs/domain';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  IdentityAuthorizationPersistenceError,
  MySqlIdentityAuthorizationRepository,
} from '../src/identity-authorization-repository.js';

type SqlCall = Readonly<{ statement: string; values: readonly unknown[] }>;

const digest = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const now = new Date('2026-09-21T12:00:00.000Z');
const later = new Date('2026-09-21T12:10:00.000Z');
const merchantUserId = toMerchantUserId('11'.repeat(16));
const otherMerchantUserId = toMerchantUserId('22'.repeat(16));
const merchantId = toMerchantId('33'.repeat(16));

const bridgeRecord: WorkBuddyBindingStateToStore = {
  stateDigest: digest(1),
  transactionId: Buffer.from(digest(2)).toString('hex'),
  merchantUserId,
  loginSessionDigest: digest(3),
  configurationId: 'workbuddy-production',
  configurationVersion: 7,
  expiresAt: later,
  createdAt: now,
};

const identity: VerifiedExternalIdentity = {
  provider: 'workbuddy',
  issuer: 'https://workbuddy.example.test',
  audience: 'h5cs-production',
  subjectLookupKey: digest(4),
  subjectLookupKeyVersion: 2,
  phoneMatchVerifiedAt: now,
  verifiedAt: now,
};

const authorization: ConnectorAuthorizationTransaction = {
  transactionDigest: digest(5),
  loginSessionDigest: digest(6),
  clientId: 'public-client-id',
  redirectUri: 'http://127.0.0.1:43123/callback',
  resource: 'https://h5cs.example.test/mcp',
  scope: 'mcp:tools',
  codeChallenge: 'A'.repeat(43),
  connectorStateDigest: digest(7),
  step: 'approved',
  merchantUserId,
  merchantId,
  candidateVersion: 3,
  expiresAt: later,
  createdAt: now,
  updatedAt: now,
};

const grant: ConnectorConsentGrant = {
  grantId: '44'.repeat(16),
  bindingId: 'binding_server_controlled',
  authorizationTransactionDigest: authorization.transactionDigest,
  merchantUserId,
  merchantId,
  clientId: authorization.clientId,
  resource: authorization.resource,
  scope: authorization.scope,
  consentVersion: '2026-09-21',
  status: 'active',
  grantedAt: now,
  revokedAt: null,
};

const resultHeader = (affectedRows = 1): ResultSetHeader => ({ affectedRows }) as ResultSetHeader;

const repositoryWith = (
  handler: (statement: string, values: readonly unknown[]) => Promise<unknown>,
) => {
  const calls: SqlCall[] = [];
  const beginTransaction = vi.fn(async () => undefined);
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const connection = {
    execute: async (statement: string, values: readonly unknown[] = []) => {
      calls.push({ statement, values });
      return handler(statement, values);
    },
    beginTransaction,
    commit,
    rollback,
    end,
  } as unknown as Connection;
  const config: DatabaseConnectionConfig = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  };
  return {
    repository: new MySqlIdentityAuthorizationRepository(config),
    calls,
    beginTransaction,
    commit,
    rollback,
    end,
  };
};

const authorizationRow = (overrides: Record<string, unknown> = {}) => ({
  transaction_digest: Buffer.from(authorization.transactionDigest),
  login_session_digest: Buffer.from(authorization.loginSessionDigest),
  client_id: authorization.clientId,
  redirect_uri: authorization.redirectUri,
  resource: authorization.resource,
  scope: authorization.scope,
  code_challenge: authorization.codeChallenge,
  connector_state_digest: Buffer.from(authorization.connectorStateDigest),
  step: authorization.step,
  merchant_user_id: Buffer.from(merchantUserId, 'hex'),
  merchant_id: Buffer.from(merchantId, 'hex'),
  candidate_version: authorization.candidateVersion,
  expires_at: authorization.expiresAt,
  consumed_at: null,
  created_at: authorization.createdAt,
  updated_at: authorization.updatedAt,
  ...overrides,
});

const externalIdentityRow = (overrides: Record<string, unknown> = {}) => ({
  id: Buffer.from('55'.repeat(16), 'hex'),
  merchant_user_id: Buffer.from(merchantUserId, 'hex'),
  provider: identity.provider,
  issuer: identity.issuer,
  audience: identity.audience,
  subject_lookup_key: Buffer.from(identity.subjectLookupKey),
  status: 'active',
  ...overrides,
});

describe('MySQL identity and Connector authorization repository', () => {
  it('defines digest-only state/session references and InnoDB constraints in the migration', async () => {
    const sql = await readFile(resolve(process.cwd(), 'migrations/0003_woozy_venom.sql'), 'utf8');

    expect(sql).toContain('`state_digest` binary(32) NOT NULL');
    expect(sql).toContain('`login_session_digest` binary(32) NOT NULL');
    expect(sql).toContain('`connector_state_digest` binary(32) NOT NULL');
    expect(sql).not.toMatch(/`(?:connector_)?state`\s+varchar/iu);
    expect(sql).not.toMatch(/`login_session`\s+varchar/iu);
    expect(sql).not.toMatch(/`open_id`/iu);
    expect(sql).not.toMatch(/`(?:authorization_)?code`\s+varchar/iu);
    expect(sql).not.toMatch(/`(?:access|refresh)_token`\s+varchar/iu);
    expect(sql.match(/ENGINE=InnoDB/gu)).toHaveLength(3);
    expect(sql).toContain('uq_external_identity_user_context');
    expect(sql).toContain('uq_connector_consent_active');
    expect(sql).toContain('fk_connector_consent_membership');
    expect(sql).toContain('fk_workbuddy_bridge_authorization');
    expect(sql).toContain('fk_oauth_refresh_family_grant');
  });

  it('stores and consumes a WorkBuddy bridge state with both state and login-session digests', async () => {
    const { repository, calls, beginTransaction, commit } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT authorization_transaction_digest')) {
        return [
          [
            {
              authorization_transaction_digest: Buffer.from(bridgeRecord.transactionId, 'hex'),
              merchant_user_id: Buffer.from(merchantUserId, 'hex'),
              login_session_digest: Buffer.from(bridgeRecord.loginSessionDigest),
              configuration_id: bridgeRecord.configurationId,
              configuration_version: bridgeRecord.configurationVersion,
              expires_at: bridgeRecord.expiresAt,
              consumed_at: null,
            },
          ],
          [],
        ];
      }
      return [resultHeader(), []];
    });

    await repository.store(bridgeRecord);
    await expect(
      repository.consume(bridgeRecord.stateDigest, bridgeRecord.loginSessionDigest, now),
    ).resolves.toEqual({
      transactionId: bridgeRecord.transactionId,
      merchantUserId,
      loginSessionDigest: bridgeRecord.loginSessionDigest,
      configurationId: bridgeRecord.configurationId,
      configurationVersion: bridgeRecord.configurationVersion,
      expiresAt: later,
    });

    const insert = calls[0];
    const select = calls[1];
    expect(insert?.values[0]).toEqual(Buffer.from(bridgeRecord.stateDigest));
    expect(insert?.values[1]).toEqual(Buffer.from(bridgeRecord.transactionId, 'hex'));
    expect(insert?.values[3]).toEqual(Buffer.from(bridgeRecord.loginSessionDigest));
    expect(insert?.values).not.toContain(bridgeRecord.transactionId);
    expect(select?.statement).toMatch(/state_digest = \? AND login_session_digest = \?/u);
    expect(select?.statement).toMatch(/FOR UPDATE/u);
    expect(select?.values).toEqual([
      Buffer.from(bridgeRecord.stateDigest),
      Buffer.from(bridgeRecord.loginSessionDigest),
    ]);
    expect(calls[2]?.statement).toMatch(/SET consumed_at/u);
    expect(beginTransaction).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('does not consume a bridge state when the bound login session has no matching row', async () => {
    const { repository, calls, commit } = repositoryWith(async () => [[], []]);

    await expect(repository.consume(digest(1), digest(99), now)).resolves.toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.statement).toMatch(/login_session_digest = \?/u);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('creates a new external identity binding without any plaintext subject identifier', async () => {
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT id, merchant_user_id')) return [[], []];
      return [resultHeader(), []];
    });

    await expect(repository.bind(merchantUserId, identity)).resolves.toEqual({ status: 'created' });

    expect(calls[0]?.statement).toMatch(/FOR UPDATE/u);
    expect(calls[1]?.statement).toContain('INSERT INTO external_identity');
    expect(calls[1]?.values[5]).toEqual(Buffer.from(identity.subjectLookupKey));
    expect(calls.flatMap((call) => call.values)).not.toContain('raw-open-id');
    expect(commit).toHaveBeenCalledOnce();
  });

  it('treats an exact active external identity binding as idempotent', async () => {
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT id, merchant_user_id')) {
        return [[externalIdentityRow()], []];
      }
      return [resultHeader(), []];
    });

    await expect(repository.bind(merchantUserId, identity)).resolves.toEqual({
      status: 'idempotent',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.statement).toMatch(/UPDATE external_identity/u);
  });

  it.each([
    [
      'the subject is retained by another account',
      externalIdentityRow({ merchant_user_id: Buffer.from(otherMerchantUserId, 'hex') }),
    ],
    [
      'the account already has another subject in the same context',
      externalIdentityRow({ subject_lookup_key: Buffer.from(digest(88)) }),
    ],
    ['the exact binding is not active', externalIdentityRow({ status: 'conflict_hold' })],
  ])('rejects a binding conflict when %s', async (_description, row) => {
    const { repository, calls, rollback } = repositoryWith(async () => [[row], []]);

    await expect(repository.bind(merchantUserId, identity)).rejects.toBeInstanceOf(
      ExternalIdentityBindingConflictError,
    );
    expect(calls).toHaveLength(1);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('classifies a duplicate-key race as idempotent only after re-reading the exact binding', async () => {
    let selects = 0;
    const duplicate = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT id, merchant_user_id')) {
        selects += 1;
        return [selects === 1 ? [] : [externalIdentityRow()], []];
      }
      if (statement.includes('INSERT INTO external_identity')) throw duplicate;
      return [resultHeader(), []];
    });

    await expect(repository.bind(merchantUserId, identity)).resolves.toEqual({
      status: 'idempotent',
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.statement).not.toMatch(/FOR UPDATE/u);
  });

  it('stores and consumes an authorization transaction using only digest references for secrets', async () => {
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT a.transaction_digest')) {
        return [[authorizationRow()], []];
      }
      return [resultHeader(), []];
    });

    await repository.storeAuthorizationTransaction(authorization);
    await expect(
      repository.consumeAuthorizationTransaction(
        authorization.transactionDigest,
        authorization.loginSessionDigest,
        now,
      ),
    ).resolves.toEqual(authorization);

    const insert = calls[0];
    const select = calls[1];
    expect(insert?.values[0]).toEqual(Buffer.from(authorization.transactionDigest));
    expect(insert?.values[1]).toEqual(Buffer.from(authorization.loginSessionDigest));
    expect(insert?.values[8]).toEqual(Buffer.from(authorization.connectorStateDigest));
    expect(select?.statement).toMatch(/transaction_digest = \? AND a\.login_session_digest = \?/u);
    expect(select?.statement).toMatch(/FOR UPDATE/u);
    expect(calls[2]?.statement).toMatch(/SET step = 'consumed'/u);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('activates consent under locks and revokes the prior grant and refresh family atomically', async () => {
    const previousGrantId = Buffer.from('66'.repeat(16), 'hex');
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT a.transaction_digest')) return [[authorizationRow()], []];
      if (statement.includes('SELECT mm.merchant_id')) return [[{ merchant_id: merchantId }], []];
      if (statement.includes('SELECT g.id')) {
        return [
          [
            {
              id: previousGrantId,
              binding_id: 'old-binding',
              authorization_transaction_digest: Buffer.from(digest(10)),
              merchant_user_id: Buffer.from(merchantUserId, 'hex'),
              merchant_id: Buffer.from('77'.repeat(16), 'hex'),
              client_id: grant.clientId,
              resource: grant.resource,
              scope: grant.scope,
              consent_version: 'old',
              status: 'active',
            },
          ],
          [],
        ];
      }
      return [resultHeader(), []];
    });

    await expect(repository.activateConsentGrant(grant, now)).resolves.toEqual({
      replacedGrantIds: [previousGrantId.toString('hex')],
    });

    expect(calls[0]?.statement).toMatch(/FOR UPDATE/u);
    expect(calls[1]?.statement).toMatch(/merchant_membership[\s\S]*FOR UPDATE/u);
    expect(calls[2]?.statement).toMatch(/active_key_digest = \?[\s\S]*FOR UPDATE/u);
    expect(calls[3]?.statement).toMatch(/UPDATE connector_consent_grant/u);
    expect(calls[4]?.statement).toMatch(/UPDATE oauth_refresh_token_family/u);
    expect(calls[5]?.statement).toMatch(/INSERT INTO connector_consent_grant/u);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('returns idempotently for the same active grant and transaction', async () => {
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT a.transaction_digest')) return [[authorizationRow()], []];
      if (statement.includes('SELECT mm.merchant_id')) return [[{ merchant_id: merchantId }], []];
      if (statement.includes('SELECT g.id')) {
        return [
          [
            {
              id: Buffer.from(grant.grantId, 'hex'),
              binding_id: grant.bindingId,
              authorization_transaction_digest: Buffer.from(grant.authorizationTransactionDigest),
              merchant_user_id: Buffer.from(merchantUserId, 'hex'),
              merchant_id: Buffer.from(merchantId, 'hex'),
              client_id: grant.clientId,
              resource: grant.resource,
              scope: grant.scope,
              consent_version: grant.consentVersion,
              status: 'active',
            },
          ],
          [],
        ];
      }
      throw new Error('must not write an idempotent grant');
    });

    await expect(repository.activateConsentGrant(grant, now)).resolves.toEqual({
      replacedGrantIds: [],
    });
    expect(calls).toHaveLength(3);
  });

  it('rejects a changed consent fact for an already-used authorization transaction', async () => {
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT a.transaction_digest')) return [[authorizationRow()], []];
      if (statement.includes('SELECT mm.merchant_id')) return [[{ merchant_id: merchantId }], []];
      if (statement.includes('SELECT g.id')) {
        return [
          [
            {
              id: Buffer.from(grant.grantId, 'hex'),
              binding_id: grant.bindingId,
              authorization_transaction_digest: Buffer.from(grant.authorizationTransactionDigest),
              merchant_user_id: Buffer.from(merchantUserId, 'hex'),
              merchant_id: Buffer.from(merchantId, 'hex'),
              client_id: grant.clientId,
              resource: grant.resource,
              scope: grant.scope,
              consent_version: 'different-version',
              status: 'active',
            },
          ],
          [],
        ];
      }
      throw new Error('must not write a conflicting grant');
    });

    await expect(repository.activateConsentGrant(grant, now)).rejects.toBeInstanceOf(
      ConnectorAuthorizationConflictError,
    );
    expect(calls).toHaveLength(3);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rolls back consent when the selected active membership no longer exists', async () => {
    const { repository, calls, commit, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT a.transaction_digest')) return [[authorizationRow()], []];
      if (statement.includes('SELECT mm.merchant_id')) return [[], []];
      throw new Error('must not continue after membership validation');
    });

    await expect(repository.activateConsentGrant(grant, now)).rejects.toBeInstanceOf(
      ConnectorAuthorizationConflictError,
    );
    expect(calls).toHaveLength(2);
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects invalid digest lengths before opening a database connection', async () => {
    const openConnection = vi.fn(async () => {
      throw new Error('must not connect');
    });
    const repository = new MySqlIdentityAuthorizationRepository({
      openConnection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    });

    await expect(repository.consume(new Uint8Array(31), digest(1), now)).rejects.toBeInstanceOf(
      IdentityAuthorizationPersistenceError,
    );
    await expect(
      repository.storeAuthorizationTransaction({
        ...authorization,
        connectorStateDigest: new Uint8Array(33),
      }),
    ).rejects.toBeInstanceOf(IdentityAuthorizationPersistenceError);
    await expect(
      repository.bind(merchantUserId, { ...identity, subjectLookupKey: new Uint8Array(31) }),
    ).rejects.toBeInstanceOf(IdentityAuthorizationPersistenceError);
    expect(openConnection).not.toHaveBeenCalled();
  });
});
