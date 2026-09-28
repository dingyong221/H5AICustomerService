import type { Connection, ResultSetHeader } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseConnectionConfig } from '../src/config.js';
import { MySqlOperatorLoginThrottleRepository } from '../src/operator-login-throttle-repository.js';

const digest = Buffer.alloc(32, 0x42);

const repositoryWith = (previousAttempts: number, expired: number) => {
  const execute = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.includes('SELECT attempts')) return [[{ attempts: previousAttempts, expired }], []];
    return [{ affectedRows: 1 } as ResultSetHeader, []];
  });
  const beginTransaction = vi.fn(async () => undefined);
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const connection = {
    execute,
    beginTransaction,
    commit,
    rollback,
    end,
  } as unknown as Connection;
  const database = {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  } satisfies DatabaseConnectionConfig;
  return {
    repository: new MySqlOperatorLoginThrottleRepository(database),
    execute,
    beginTransaction,
    commit,
    rollback,
    end,
  };
};

describe('operator login throttling', () => {
  it('atomically reserves an allowed attempt before password verification', async () => {
    const { repository, execute, beginTransaction, commit, rollback, end } = repositoryWith(4, 0);
    await expect(repository.consumeAttempt(digest)).resolves.toBe(true);
    expect(execute.mock.calls[0]?.[0]).toContain('ON DUPLICATE KEY UPDATE');
    expect(execute.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(execute.mock.calls[2]?.[1]).toEqual([5, false, digest]);
    expect(beginTransaction).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it('rejects the sixth attempt and resets the counter after its window expires', async () => {
    const blocked = repositoryWith(5, 0);
    await expect(blocked.repository.consumeAttempt(digest)).resolves.toBe(false);
    expect(blocked.execute.mock.calls[2]?.[1]).toEqual([6, false, digest]);

    const reset = repositoryWith(6, 1);
    await expect(reset.repository.consumeAttempt(digest)).resolves.toBe(true);
    expect(reset.execute.mock.calls[2]?.[1]).toEqual([1, true, digest]);
  });

  it('fails closed on missing throttle state and clears it only after successful auth', async () => {
    const missing = repositoryWith(0, 0);
    missing.execute.mockImplementationOnce(async () => [
      { affectedRows: 1 } as ResultSetHeader,
      [],
    ]);
    missing.execute.mockImplementationOnce(async () => [[], []]);
    await expect(missing.repository.consumeAttempt(digest)).rejects.toThrow();
    expect(missing.rollback).toHaveBeenCalledOnce();
    expect(missing.commit).not.toHaveBeenCalled();

    const success = repositoryWith(0, 0);
    await success.repository.clear(digest);
    expect(success.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM platform_operator_login_throttle WHERE source_digest'),
      [digest],
    );
    await expect(success.repository.clear(Buffer.alloc(31))).rejects.toThrow();
  });
});
