import { describe, expect, it, vi } from 'vitest';

import {
  ExternalIdentityBindingConflictError,
  MerchantSelectionRequiredError,
  toAssistantId,
  toMerchantId,
  toMerchantUserId,
  toOnboardingSessionId,
} from '@h5cs/domain';
import type { Connection, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import {
  MySqlOnboardingRepository,
  OnboardingPersistenceError,
} from '../src/onboarding-repository.js';

const merchantUserId = toMerchantUserId('11111111111111111111111111111111');

const configWithBindings = (
  ids: readonly string[],
  statements: string[],
): DatabaseConnectionConfig => {
  const connection = {
    execute: async (statement: string) => {
      statements.push(statement);
      return [ids.map((id) => ({ merchant_id: Buffer.from(id, 'hex') })) as RowDataPacket[], []];
    },
    end: async () => undefined,
  } as unknown as Connection;

  return {
    openConnection: async () => connection,
    summary: { host: 'test', database: 'test', tlsRequested: false },
    toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
  };
};

describe('MySQL onboarding repository merchant binding', () => {
  it('reads at most two active memberships and blocks ambiguous selection', async () => {
    const statements: string[] = [];
    const repository = new MySqlOnboardingRepository(
      configWithBindings(
        ['22222222222222222222222222222222', '33333333333333333333333333333333'],
        statements,
      ),
    );

    await expect(repository.findMerchantBinding(merchantUserId)).rejects.toThrow(
      MerchantSelectionRequiredError,
    );
    expect(statements[0]).toMatch(/LIMIT 2/u);
    expect(statements[0]).toMatch(/m\.status = 'active' AND u\.status = 'active'/u);
  });

  it('scopes assistant summaries to the active merchant membership', async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const connection = {
      execute: async (sql: string, values: readonly unknown[]) => {
        calls.push({ sql, values });
        return [[], []];
      },
      end: async () => undefined,
    } as unknown as Connection;
    const repository = new MySqlOnboardingRepository({
      openConnection: async () => connection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    });

    await expect(
      repository.listAssistants(toMerchantId('22222222222222222222222222222222'), merchantUserId),
    ).resolves.toEqual([]);
    expect(calls[0]?.sql).toMatch(/mm\.merchant_user_id = \?/u);
    expect(calls[0]?.sql).toMatch(/mm\.status = 'active' AND u\.status = 'active'/u);
    expect(calls[0]?.values).toEqual([
      Buffer.from('22222222222222222222222222222222', 'hex'),
      Buffer.from(merchantUserId, 'hex'),
    ]);
  });

  it('returns the sole active membership without exposing a caller selection parameter', async () => {
    const repository = new MySqlOnboardingRepository(
      configWithBindings(['22222222222222222222222222222222'], []),
    );

    await expect(repository.findMerchantBinding(merchantUserId)).resolves.toBe(
      '22222222222222222222222222222222',
    );
  });

  it('fails closed when a retained external identity is not active', async () => {
    const execute = vi.fn(async (_statement: string) => [
      [
        {
          merchant_user_id: Buffer.from(merchantUserId, 'hex'),
          status: 'revoked',
        },
      ] as RowDataPacket[],
      [],
    ]);
    const connection = {
      execute,
      end: async () => undefined,
    } as unknown as Connection;
    const repository = new MySqlOnboardingRepository({
      openConnection: async () => connection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    });

    await expect(
      repository.resolveOrCreateMerchantUser({
        provider: 'workbuddy',
        issuer: 'https://workbuddy.example.test',
        audience: 'h5cs-production',
        subjectLookupKey: new Uint8Array(32).fill(1),
        subjectLookupKeyVersion: 1,
        phoneMatchVerifiedAt: null,
        verifiedAt: new Date('2026-09-21T12:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ExternalIdentityBindingConflictError);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatch(/SELECT merchant_user_id, status/u);
  });

  it('rejects caller-reported generation success outside the lifecycle transaction', async () => {
    const openConnection = vi.fn(async () => {
      throw new Error('must not connect');
    });
    const repository = new MySqlOnboardingRepository({
      openConnection,
      summary: { host: 'test', database: 'test', tlsRequested: false },
      toJSON: () => ({ host: 'test', database: 'test', tlsRequested: false }),
    });
    const assistantId = toAssistantId('44444444444444444444444444444444');

    await expect(
      repository.saveGenerationResult(
        {
          id: toOnboardingSessionId('33333333333333333333333333333333'),
          merchantUserId,
          merchantId: null,
          assistantId: null,
          snapshot: { state: 'generating', answers: {} },
          version: 1,
        },
        { state: 'manageable', answers: {}, generatedAssistantId: assistantId },
        toMerchantId('22222222222222222222222222222222'),
        assistantId,
      ),
    ).rejects.toBeInstanceOf(OnboardingPersistenceError);
    expect(openConnection).not.toHaveBeenCalled();
  });
});
