import { describe, expect, it, vi } from 'vitest';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  MerchantConversationUnavailableError,
  MySqlMerchantConversationRepository,
} from '../src/merchant-conversation-repository.js';

const merchantId = '11'.repeat(16);
const merchantUserId = '22'.repeat(16);
const sessionId = '33'.repeat(16);
const assistantId = '44'.repeat(16);
const releaseId = '55'.repeat(16);
const activity = new Date('2026-09-25T08:00:00.000Z');
const sessionRow = {
  id: Buffer.from(sessionId, 'hex'),
  assistant_id: Buffer.from(assistantId, 'hex'),
  assistant_name: '售前客服',
  release_id: Buffer.from(releaseId, 'hex'),
  status: 'active',
  follow_up_status: 'pending',
  last_activity_at: activity,
  last_activity_cursor: '2026-09-25 08:00:00.123456',
  created_at: activity,
};

const databaseWith = (execute: Connection['execute']) => {
  const end = vi.fn(async () => undefined);
  const beginTransaction = vi.fn(async () => undefined);
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const connection = { execute, end, beginTransaction, commit, rollback } as unknown as Connection;
  const database = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  } satisfies DatabaseConnectionConfig;
  return {
    repository: new MySqlMerchantConversationRepository(database),
    end,
    beginTransaction,
    commit,
    rollback,
  };
};

describe('merchant consultation repository', () => {
  it('scopes a cursor page to an active member and retains MySQL microsecond precision', async () => {
    const execute = vi.fn(async (_sql: string, _values: readonly unknown[]) => [
      [sessionRow, sessionRow],
      [],
    ]);
    const { repository, end } = databaseWith(execute as unknown as Connection['execute']);
    const first = await repository.list({ merchantId, merchantUserId, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ sessionId, assistantId, followUpStatus: 'pending' });
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    expect(cursor.at).toBe('2026-09-25 08:00:00.123456');
    await repository.list({ merchantId, merchantUserId, cursor: first.nextCursor, limit: 1 });
    const [, values] = execute.mock.calls[1]!;
    expect(values[0]).toEqual(Buffer.from(merchantUserId, 'hex'));
    expect(values[1]).toEqual(Buffer.from(merchantId, 'hex'));
    expect(values[2]).toBe('2026-09-25 08:00:00.123456');
    expect(execute.mock.calls[1]?.[0]).toContain("mm.status = 'active'");
    expect(end).toHaveBeenCalledTimes(2);
    await expect(
      repository.list({ merchantId, merchantUserId, cursor: 'invalid!' }),
    ).rejects.toThrow(MerchantConversationUnavailableError);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('never fetches messages when the merchant membership check finds no session', async () => {
    const execute = vi.fn(async (_sql: string) => [[], []]);
    const { repository } = databaseWith(execute as unknown as Connection['execute']);
    await expect(repository.detail({ merchantId, merchantUserId, sessionId })).resolves.toBeNull();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toContain('mm.merchant_user_id = ?');
  });

  it('updates follow-up state and audit atomically only for an authorized session', async () => {
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT cs.follow_up_status'))
        return [[{ follow_up_status: 'pending' }], []];
      return [{ affectedRows: 1 } as ResultSetHeader, []];
    });
    const { repository, commit, rollback } = databaseWith(
      execute as unknown as Connection['execute'],
    );
    await repository.setFollowUpStatus({
      merchantId,
      merchantUserId,
      sessionId,
      status: 'in_progress',
    });
    expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('UPDATE conversation_session'),
      expect.stringContaining('INSERT INTO audit_log'),
    ]);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back unauthorized follow-up changes without writing an audit success', async () => {
    const execute = vi.fn(async (_sql: string) => [[], []]);
    const { repository, commit, rollback } = databaseWith(
      execute as unknown as Connection['execute'],
    );
    await expect(
      repository.setFollowUpStatus({ merchantId, merchantUserId, sessionId, status: 'resolved' }),
    ).rejects.toThrow(MerchantConversationUnavailableError);
    expect(execute).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });
});
