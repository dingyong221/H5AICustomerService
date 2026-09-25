import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { Connection, ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  MerchantInvitationNotReissuableError,
  MerchantProvisionAlreadyAppliedError,
  MerchantProvisionIdempotencyConflictError,
  MySqlPlatformProvisioningRepository,
} from '../src/platform-provisioning-repository.js';

const resultHeader = { affectedRows: 1 } as ResultSetHeader;

const repositoryWith = (failOn?: string, merchantStatus = 'pending_owner', failEnd = false) => {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const end = vi.fn(async () => {
    if (failEnd) throw new Error('simulated connection close failure');
  });
  const connection = {
    execute: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      if (failOn && sql.includes(failOn)) throw new Error('simulated database failure');
      if (sql.includes('SELECT name, status FROM merchant')) {
        return [[{ name: '示例商家', status: merchantStatus }], []];
      }
      return [resultHeader, []];
    },
    beginTransaction: vi.fn(async () => undefined),
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
    repository: new MySqlPlatformProvisioningRepository(database),
    calls,
    commit,
    rollback,
    end,
  };
};

describe('platform merchant provisioning', () => {
  it('lists only bounded platform audit fields without metadata or conversation content', async () => {
    const auditId = Buffer.from('11'.repeat(16), 'hex');
    const merchantId = Buffer.from('22'.repeat(16), 'hex');
    const occurredAt = new Date('2026-09-25T04:00:00.000Z');
    const execute = vi.fn(async (_sql: string, _values: readonly unknown[]) => [
      [
        {
          id: auditId,
          actor_id: 'ops-1',
          action: 'merchant.provision',
          merchant_id: merchantId,
          result: 'success',
          occurred_at: occurredAt,
        },
      ],
      [],
    ]);
    const end = vi.fn(async () => undefined);
    const database = {
      openConnection: async () => ({ execute, end }) as unknown as Connection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    } satisfies DatabaseConnectionConfig;
    const repository = new MySqlPlatformProvisioningRepository(database);

    await expect(repository.listPlatformAudits(5)).resolves.toEqual([
      {
        id: auditId.toString('hex'),
        operatorId: 'ops-1',
        action: 'merchant.provision',
        merchantId: merchantId.toString('hex'),
        result: 'success',
        occurredAt,
      },
    ]);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("WHERE actor_type = 'platform_operator'"),
      [5],
    );
    expect(execute.mock.calls[0]?.[0]).not.toMatch(/metadata|reason|message|contact/iu);
    expect(end).toHaveBeenCalledOnce();
    await expect(repository.listPlatformAudits(101)).rejects.toThrow('Audit list limit is invalid');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('commits a pending merchant, one-time digest, and audit record together', async () => {
    const { repository, calls, commit, rollback } = repositoryWith();
    const created = await repository.provisionMerchant({
      name: '  示例商家  ',
      operatorId: 'ops-1',
    });

    expect(created).toMatchObject({ name: '示例商家', status: 'pending_owner' });
    expect(created.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const invite = calls.find((call) => call.sql.includes('INSERT INTO merchant_setup_invitation'));
    expect(invite).toBeDefined();
    expect(invite!.values[0]).toEqual(
      createHash('sha256').update(created.setupToken, 'ascii').digest(),
    );
    expect(calls.some((call) => JSON.stringify(call.values).includes(created.setupToken))).toBe(
      false,
    );
    expect(calls.some((call) => call.sql.includes('INSERT INTO audit_log'))).toBe(true);
    expect(calls[0]?.sql).toContain('INSERT INTO idempotency_record');
    expect(calls.some((call) => call.sql.includes("state = 'succeeded'"))).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not create a second merchant when the same provisioning key already committed', async () => {
    const merchantId = Buffer.from('aa'.repeat(16), 'hex');
    const requestHash = createHash('sha256').update('示例商家', 'utf8').digest();
    const firstExecute = vi.fn(async () => {
      throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
    });
    const secondExecute = vi.fn(async () => [
      [{ request_hash: requestHash, state: 'succeeded', resource_id: merchantId }],
      [],
    ]);
    const rollback = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    const connections = [
      {
        execute: firstExecute,
        beginTransaction: async () => undefined,
        rollback,
        commit,
        end: async () => undefined,
      },
      { execute: secondExecute, end: async () => undefined },
    ];
    const database = {
      openConnection: async () => connections.shift() as unknown as Connection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    } satisfies DatabaseConnectionConfig;
    const repository = new MySqlPlatformProvisioningRepository(database);
    await expect(
      repository.provisionMerchant({
        name: '示例商家',
        operatorId: 'ops-1',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toMatchObject({
      name: MerchantProvisionAlreadyAppliedError.name,
      merchantId: merchantId.toString('hex'),
    });
    expect(firstExecute).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(secondExecute).toHaveBeenCalledWith(
      expect.stringContaining("operation = 'merchant.provision'"),
      expect.any(Array),
    );
  });

  it('rejects a provisioning key reused with a different merchant name', async () => {
    const first = {
      execute: async () => {
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      },
      beginTransaction: async () => undefined,
      rollback: async () => undefined,
      end: async () => undefined,
    };
    const second = {
      execute: async () => [
        [
          {
            request_hash: createHash('sha256').update('其他商家', 'utf8').digest(),
            state: 'succeeded',
            resource_id: Buffer.from('aa'.repeat(16), 'hex'),
          },
        ],
        [],
      ],
      end: async () => undefined,
    };
    const connections = [first, second];
    const database = {
      openConnection: async () => connections.shift() as unknown as Connection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    } satisfies DatabaseConnectionConfig;
    const repository = new MySqlPlatformProvisioningRepository(database);
    await expect(
      repository.provisionMerchant({
        name: '示例商家',
        operatorId: 'ops-1',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBeInstanceOf(MerchantProvisionIdempotencyConflictError);
  });

  it('rolls back if the invitation cannot be inserted', async () => {
    const { repository, commit, rollback } = repositoryWith(
      'INSERT INTO merchant_setup_invitation',
    );
    await expect(
      repository.provisionMerchant({ name: '示例商家', operatorId: 'ops-1' }),
    ).rejects.toThrow('simulated database failure');
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('still returns the one-time link after a committed create when connection cleanup fails', async () => {
    const { repository, commit, rollback, end } = repositoryWith(undefined, 'pending_owner', true);
    const created = await repository.provisionMerchant({ name: '示例商家', operatorId: 'ops-1' });
    expect(created.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it('reissues a pending invitation by expiring old links and auditing the new digest atomically', async () => {
    const { repository, calls, commit, rollback } = repositoryWith();
    const merchantId = '22222222222222222222222222222222';
    const created = await repository.reissueInvitation({ merchantId, operatorId: 'ops-1' });

    expect(created).toMatchObject({ id: merchantId, name: '示例商家', status: 'pending_owner' });
    expect(created.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const expiryIndex = calls.findIndex((call) =>
      call.sql.includes('UPDATE merchant_setup_invitation'),
    );
    const insertIndex = calls.findIndex((call) =>
      call.sql.includes('INSERT INTO merchant_setup_invitation'),
    );
    expect(calls[0]?.sql).toContain('FOR UPDATE');
    expect(expiryIndex).toBeGreaterThan(0);
    expect(insertIndex).toBeGreaterThan(expiryIndex);
    expect(calls[insertIndex]?.values[0]).toEqual(
      createHash('sha256').update(created.setupToken, 'ascii').digest(),
    );
    expect(calls.some((call) => JSON.stringify(call.values).includes(created.setupToken))).toBe(
      false,
    );
    expect(calls.some((call) => call.sql.includes('merchant.invitation.reissue'))).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('refuses to reissue after the merchant has already been claimed', async () => {
    const { repository, calls, commit, rollback } = repositoryWith(undefined, 'active');
    await expect(
      repository.reissueInvitation({
        merchantId: '22222222222222222222222222222222',
        operatorId: 'ops-1',
      }),
    ).rejects.toThrow(MerchantInvitationNotReissuableError);
    expect(calls).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('rolls back old-link invalidation if the new invitation cannot be inserted', async () => {
    const { repository, commit, rollback } = repositoryWith(
      'INSERT INTO merchant_setup_invitation',
    );
    await expect(
      repository.reissueInvitation({
        merchantId: '22222222222222222222222222222222',
        operatorId: 'ops-1',
      }),
    ).rejects.toThrow('simulated database failure');
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('still returns a reissued link after commit when connection cleanup fails', async () => {
    const { repository, commit, rollback, end } = repositoryWith(undefined, 'pending_owner', true);
    const created = await repository.reissueInvitation({
      merchantId: '22222222222222222222222222222222',
      operatorId: 'ops-1',
    });
    expect(created.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });
});
