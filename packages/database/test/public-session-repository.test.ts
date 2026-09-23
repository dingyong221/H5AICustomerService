import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  MySqlPublicSessionRepository,
  PublicSessionUnavailableError,
} from '../src/public-session-repository.js';

const key = randomBytes(32).toString('base64url');
const visitorNonce = randomBytes(32).toString('base64url');
const now = new Date('2026-09-24T00:00:00.000Z');
const expiresAt = new Date(now.getTime() + 30 * 60 * 1_000);
const publicSlug = 'a-example-assistant';
const sessionRequestId = `session_request_${'11'.repeat(16)}`;
const merchantId = Buffer.from('22'.repeat(16), 'hex');
const assistantId = Buffer.from('33'.repeat(16), 'hex');
const releaseId = Buffer.from('44'.repeat(16), 'hex');
const resultHeader = { affectedRows: 1 } as ResultSetHeader;

const repositoryWith = (
  handler: (statement: string, values: readonly unknown[]) => Promise<unknown>,
) => {
  const calls: Array<{ statement: string; values: readonly unknown[] }> = [];
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const connection = {
    execute: async (statement: string, values: readonly unknown[] = []) => {
      calls.push({ statement, values });
      return handler(statement, values);
    },
    beginTransaction: vi.fn(async () => undefined),
    commit,
    rollback,
    end: vi.fn(async () => undefined),
  } as unknown as Connection;
  const database = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  } satisfies DatabaseConnectionConfig;
  return { repository: new MySqlPublicSessionRepository(database, key), calls, commit, rollback };
};

describe('MySQL public visitor sessions', () => {
  it('pins a published release and stores a credential digest, never the raw handle', async () => {
    const { repository, calls, commit } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT cs.release_id')) return [[], []];
      if (statement.includes('SELECT a.id AS assistant_id')) {
        return [
          [{ assistant_id: assistantId, merchant_id: merchantId, release_id: releaseId }],
          [],
        ];
      }
      return [resultHeader, []];
    });
    const created = await repository.createSession({
      publicSlug,
      sessionRequestId,
      visitorNonce,
      now,
    });

    expect(created).toMatchObject({ releaseRef: releaseId.toString('hex'), state: 'active' });
    expect(created.sessionHandle).toMatch(/^s_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/u);
    const insert = calls.find((call) =>
      call.statement.includes('INSERT INTO conversation_session'),
    );
    expect(insert).toBeDefined();
    expect(insert!.values[4]).toBeInstanceOf(Buffer);
    expect((insert!.values[4] as Buffer).byteLength).toBe(16);
    expect(calls.some((call) => JSON.stringify(call.values).includes(created.sessionHandle))).toBe(
      false,
    );
    expect(commit).toHaveBeenCalledOnce();
  });

  it('returns the original pinned release on a scoped idempotent retry', async () => {
    const { repository, calls } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT cs.release_id')) {
        return [
          [{ release_id: releaseId, created_at: now, expires_at: expiresAt, status: 'active' }],
          [],
        ];
      }
      throw new Error('must not create another session');
    });
    const first = await repository.createSession({
      publicSlug,
      sessionRequestId,
      visitorNonce,
      now,
    });
    const second = await repository.createSession({
      publicSlug,
      sessionRequestId,
      visitorNonce,
      now,
    });
    expect(second).toEqual(first);
    expect(
      calls.every((call) => !call.statement.includes('INSERT INTO conversation_session')),
    ).toBe(true);
  });

  it('resumes only with the original visitor nonce and never creates another session', async () => {
    let issuedSessionId: Buffer | undefined;
    let issuedCredentialId: Buffer | undefined;
    const { repository, calls } = repositoryWith(async (statement, values) => {
      if (statement.includes('SELECT cs.release_id')) {
        return [
          issuedSessionId?.equals(values[0] as Buffer) &&
          issuedCredentialId?.equals(values[1] as Buffer)
            ? [{ release_id: releaseId, created_at: now, expires_at: expiresAt, status: 'active' }]
            : [],
          [],
        ];
      }
      if (statement.includes('SELECT a.id AS assistant_id')) {
        return [
          [{ assistant_id: assistantId, merchant_id: merchantId, release_id: releaseId }],
          [],
        ];
      }
      if (statement.includes('INSERT INTO conversation_session')) {
        issuedSessionId = values[0] as Buffer;
        issuedCredentialId = values[4] as Buffer;
      }
      return [resultHeader, []];
    });
    const issued = await repository.createSession({
      publicSlug,
      sessionRequestId,
      visitorNonce,
      now,
    });
    calls.length = 0;
    await expect(
      repository.resumeSession({ publicSlug, sessionRequestId, visitorNonce, now }),
    ).resolves.toEqual(issued);
    await expect(
      repository.resumeSession({
        publicSlug,
        sessionRequestId,
        visitorNonce: randomBytes(32).toString('base64url'),
        now,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.resumeSession({ publicSlug, sessionRequestId, visitorNonce, now: expiresAt }),
    ).resolves.toBeNull();
    expect(calls.every((call) => !call.statement.includes('INSERT INTO'))).toBe(true);
  });

  it('returns bounded pinned history only to the bearer session handle', async () => {
    let credentialId: Buffer | undefined;
    const activeTurnId = Buffer.from('88'.repeat(16), 'hex');
    const visitorMessageId = `message_${'55'.repeat(16)}`;
    const { repository, calls } = repositoryWith(async (statement, values) => {
      if (statement.includes('SELECT cs.release_id')) return [[], []];
      if (statement.includes('SELECT a.id AS assistant_id')) {
        return [
          [{ assistant_id: assistantId, merchant_id: merchantId, release_id: releaseId }],
          [],
        ];
      }
      if (statement.includes('INSERT INTO conversation_session'))
        credentialId = values[4] as Buffer;
      if (statement.includes('SELECT cs.merchant_id') && statement.includes('r.config_snapshot')) {
        return [
          (values[1] as Buffer).equals(credentialId!)
            ? [
                {
                  merchant_id: merchantId,
                  assistant_id: assistantId,
                  release_id: releaseId,
                  created_at: now,
                  active_turn_id: activeTurnId,
                  public_slug: publicSlug,
                  merchant_name: '示例商家',
                  config_snapshot: {
                    displayName: '售前助手',
                    businessScope: '空调清洗',
                    welcomeMessage: '你好',
                  },
                },
              ]
            : [],
          [],
        ];
      }
      if (statement.includes('FROM message')) {
        return [
          [
            {
              id: Buffer.from('77'.repeat(16), 'hex'),
              turn_id: activeTurnId,
              seq_no: 1,
              role: 'visitor',
              state: 'accepted',
              client_request_id: visitorMessageId,
              content: '多少钱？',
              created_at: now,
            },
          ],
          [],
        ];
      }
      return [resultHeader, []];
    });
    const issued = await repository.createSession({
      publicSlug,
      sessionRequestId,
      visitorNonce,
      now,
    });
    calls.length = 0;
    await expect(repository.readHistory(issued.sessionHandle, now)).resolves.toMatchObject({
      sessionHandle: issued.sessionHandle,
      releaseRef: releaseId.toString('hex'),
      snapshot: { publicAssistantId: publicSlug, assistantDisplayName: '售前助手' },
      messages: [{ role: 'visitor', clientMessageId: visitorMessageId }],
      activeTurn: { turnId: `t_${'88'.repeat(16)}`, clientMessageId: visitorMessageId },
      hasEarlierMessages: false,
    });
    const [prefix, sessionId, secret] = issued.sessionHandle.split('_');
    const changedSecret = `${secret!.startsWith('A') ? 'B' : 'A'}${secret!.slice(1)}`;
    const messageQueries = calls.filter((call) => call.statement.includes('FROM message')).length;
    await expect(
      repository.readHistory(`${prefix}_${sessionId}_${changedSecret}`, now),
    ).resolves.toBeNull();
    expect(calls.filter((call) => call.statement.includes('FROM message'))).toHaveLength(
      messageQueries,
    );
    expect(calls.some((call) => call.statement.includes('LIMIT 201'))).toBe(true);
  });

  it('refuses an assistant without an active published release', async () => {
    const { repository, calls, rollback } = repositoryWith(async (statement) => {
      if (statement.includes('SELECT cs.release_id')) return [[], []];
      if (statement.includes('SELECT a.id AS assistant_id')) return [[], []];
      throw new Error('unexpected write');
    });
    await expect(
      repository.createSession({ publicSlug, sessionRequestId, visitorNonce, now }),
    ).rejects.toBeInstanceOf(PublicSessionUnavailableError);
    expect(calls.some((call) => call.statement.includes('INSERT INTO conversation_session'))).toBe(
      false,
    );
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('resolves only the visitor bearer credential while preserving the pinned release', async () => {
    let issuedCredentialId: Buffer | undefined;
    const { repository: issuer } = repositoryWith(async (statement, values) => {
      if (statement.includes('SELECT cs.release_id')) return [[], []];
      if (statement.includes('SELECT a.id AS assistant_id')) {
        return [
          [{ assistant_id: assistantId, merchant_id: merchantId, release_id: releaseId }],
          [],
        ];
      }
      if (statement.includes('INSERT INTO conversation_session')) {
        issuedCredentialId = values[4] as Buffer;
      }
      return [resultHeader, []];
    });
    const issued = await issuer.createSession({ publicSlug, sessionRequestId, visitorNonce, now });
    const { repository, calls } = repositoryWith(async (statement, values) => {
      if (statement.includes('FROM conversation_session cs')) {
        if (!(values[1] as Buffer).equals(issuedCredentialId!)) return [[], []];
        return [
          [
            {
              merchant_id: merchantId,
              assistant_id: assistantId,
              release_id: releaseId,
              expires_at: expiresAt,
              config_snapshot: { businessScope: '空调清洗' },
            },
          ],
          [],
        ];
      }
      throw new Error('unexpected SQL');
    });
    await expect(repository.resolveSession(issued.sessionHandle, now)).resolves.toMatchObject({
      releaseId: releaseId.toString('hex'),
      configSnapshot: { businessScope: '空调清洗' },
    });
    expect(calls[0]?.statement).toContain('cs.visitor_credential_id = ?');
    expect(calls[0]?.statement).not.toContain("r.status = 'active'");
    await expect(repository.resolveSession('s_invalid', now)).resolves.toBeNull();
    const [prefix, sessionId, secret] = issued.sessionHandle.split('_');
    const changedSecret = `${secret!.startsWith('A') ? 'B' : 'A'}${secret!.slice(1)}`;
    await expect(
      repository.resolveSession(`${prefix}_${sessionId}_${changedSecret}`, now),
    ).resolves.toBeNull();
  });

  it('accepts one message and queues one durable job, then returns the same turn on retry', async () => {
    let activeTurnId: Buffer | null = null;
    let originalTurnId: Buffer | null = null;
    let originalContent: string | null = null;
    let originalClientMessageId: string | null = null;
    const { repository, calls, commit } = repositoryWith(async (statement, values) => {
      if (statement.includes('SELECT cs.release_id')) return [[], []];
      if (statement.includes('SELECT a.id AS assistant_id')) {
        return [
          [{ assistant_id: assistantId, merchant_id: merchantId, release_id: releaseId }],
          [],
        ];
      }
      if (statement.includes('SELECT cs.merchant_id')) {
        return [
          [
            {
              merchant_id: merchantId,
              assistant_id: assistantId,
              release_id: releaseId,
              active_turn_id: activeTurnId,
              next_sequence: 1,
            },
          ],
          [],
        ];
      }
      if (statement.includes('SELECT turn_id, content FROM message')) {
        return [
          originalTurnId && values[3] === originalClientMessageId
            ? [{ turn_id: originalTurnId, content: originalContent }]
            : [],
          [],
        ];
      }
      if (statement.includes('INSERT INTO message')) {
        originalTurnId = values[4] as Buffer;
        originalClientMessageId = values[6] as string;
        originalContent = values[7] as string;
      }
      if (statement.includes('UPDATE conversation_session')) activeTurnId = values[0] as Buffer;
      return [resultHeader, []];
    });
    const issued = await repository.createSession({
      publicSlug,
      sessionRequestId,
      visitorNonce,
      now,
    });
    calls.length = 0;
    const input = {
      sessionHandle: issued.sessionHandle,
      clientMessageId: `message_${'55'.repeat(16)}`,
      content: '清洗空调多少钱？',
      now,
    };
    const first = await repository.acceptTurn(input);
    const second = await repository.acceptTurn(input);
    expect(first).toEqual(second);
    expect(first.turnId).toMatch(/^t_[0-9a-f]{32}$/u);
    expect(calls.filter((call) => call.statement.includes('INSERT INTO message'))).toHaveLength(1);
    expect(calls.filter((call) => call.statement.includes('INSERT INTO job'))).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(3);
    await expect(
      repository.acceptTurn({ ...input, content: '改成其他问题' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      repository.acceptTurn({ ...input, clientMessageId: `message_${'66'.repeat(16)}` }),
    ).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });
  });

  it('reads a turn only through its bound visitor credential', async () => {
    let credentialId: Buffer | undefined;
    const { repository, calls } = repositoryWith(async (statement, values) => {
      if (statement.includes('SELECT cs.release_id')) return [[], []];
      if (statement.includes('SELECT a.id AS assistant_id')) {
        return [
          [{ assistant_id: assistantId, merchant_id: merchantId, release_id: releaseId }],
          [],
        ];
      }
      if (statement.includes('INSERT INTO conversation_session'))
        credentialId = values[4] as Buffer;
      if (statement.includes('SELECT cs.merchant_id')) {
        return [
          (values[1] as Buffer).equals(credentialId!)
            ? [{ merchant_id: merchantId, assistant_id: assistantId }]
            : [],
          [],
        ];
      }
      if (statement.includes('FROM message')) {
        return [
          [
            {
              id: Buffer.from('77'.repeat(16), 'hex'),
              seq_no: 1,
              role: 'visitor',
              state: 'accepted',
              client_request_id: `message_${'55'.repeat(16)}`,
              content: '清洗空调多少钱？',
              error_code: null,
              created_at: now,
              turn_id: Buffer.from('88'.repeat(16), 'hex'),
            },
          ],
          [],
        ];
      }
      return [resultHeader, []];
    });
    const issued = await repository.createSession({
      publicSlug,
      sessionRequestId,
      visitorNonce,
      now,
    });
    const turnId = `t_${'88'.repeat(16)}`;
    const result = await repository.readTurn(issued.sessionHandle, turnId, now);
    expect(result).toMatchObject({
      turnId,
      state: 'accepted',
      messages: [{ role: 'visitor', clientMessageId: `message_${'55'.repeat(16)}` }],
    });
    const [prefix, sessionId, secret] = issued.sessionHandle.split('_');
    const tamperedHandle = `${prefix}_${sessionId}_${secret!.startsWith('A') ? 'B' : 'A'}${secret!.slice(1)}`;
    const previousMessageQueries = calls.filter((call) =>
      call.statement.includes('FROM message'),
    ).length;
    await expect(repository.readTurn(tamperedHandle, turnId, now)).resolves.toBeNull();
    expect(calls.filter((call) => call.statement.includes('FROM message'))).toHaveLength(
      previousMessageQueries,
    );
  });
});
