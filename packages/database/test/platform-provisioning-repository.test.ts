import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import { MySqlPlatformProvisioningRepository } from '../src/platform-provisioning-repository.js';

const resultHeader = { affectedRows: 1 } as ResultSetHeader;

const repositoryWith = (failOn?: string) => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const connection = {
    execute: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (failOn && sql.includes(failOn)) throw new Error('simulated database failure');
      return [resultHeader, []];
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
  return { repository: new MySqlPlatformProvisioningRepository(database), calls, commit, rollback };
};

describe('platform merchant provisioning', () => {
  it('commits a pending merchant, one-time digest, and audit record together', async () => {
    const { repository, calls, commit, rollback } = repositoryWith();
    const created = await repository.provisionMerchant({ name: '  示例商家  ', operatorId: 'ops-1' });

    expect(created).toMatchObject({ name: '示例商家', status: 'pending_owner' });
    expect(created.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const invite = calls.find((call) => call.sql.includes('INSERT INTO merchant_setup_invitation'));
    expect(invite).toBeDefined();
    expect(invite!.values[0]).toEqual(createHash('sha256').update(created.setupToken, 'ascii').digest());
    expect(calls.some((call) => JSON.stringify(call.values).includes(created.setupToken))).toBe(false);
    expect(calls.some((call) => call.sql.includes('INSERT INTO audit_log'))).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back if the invitation cannot be inserted', async () => {
    const { repository, commit, rollback } = repositoryWith('INSERT INTO merchant_setup_invitation');
    await expect(repository.provisionMerchant({ name: '示例商家', operatorId: 'ops-1' }))
      .rejects.toThrow('simulated database failure');
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });
});
