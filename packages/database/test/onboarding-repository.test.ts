import { describe, expect, it } from 'vitest';

import { MerchantSelectionRequiredError, toMerchantUserId } from '@h5cs/domain';
import type { Connection, RowDataPacket } from 'mysql2/promise';

import type { DatabaseConnectionConfig } from '../src/config.js';
import { MySqlOnboardingRepository } from '../src/onboarding-repository.js';

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
  });

  it('returns the sole active membership without exposing a caller selection parameter', async () => {
    const repository = new MySqlOnboardingRepository(
      configWithBindings(['22222222222222222222222222222222'], []),
    );

    await expect(repository.findMerchantBinding(merchantUserId)).resolves.toBe(
      '22222222222222222222222222222222',
    );
  });
});
