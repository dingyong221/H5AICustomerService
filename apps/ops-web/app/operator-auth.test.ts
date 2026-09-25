import { randomBytes, scryptSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createOperatorSession,
  loadOperatorAuthConfig,
  operatorLoginSourceDigest,
  resolveOperatorSession,
  verifyOperatorPassword,
} from './operator-auth';

const environment = () => {
  const salt = randomBytes(16);
  return {
    NODE_ENV: 'test' as const,
    OPS_ADMIN_USERNAME: 'h5cs-admin',
    OPS_ADMIN_PASSWORD_HASH: `scrypt:${salt.toString('base64url')}:${scryptSync('a-long-test-password', salt, 64).toString('base64url')}`,
    OPS_SESSION_SIGNING_KEY: randomBytes(32).toString('base64url'),
    OPS_PUBLIC_ORIGIN: 'https://ops.example.test',
  };
};

describe('platform operator authentication', () => {
  it('fails closed without all four production configuration values', () => {
    const values = environment();
    expect(loadOperatorAuthConfig({ ...values, OPS_ADMIN_PASSWORD_HASH: '' })).toBeNull();
    expect(
      loadOperatorAuthConfig({ ...values, OPS_PUBLIC_ORIGIN: 'http://ops.example.test' }),
    ).toBeNull();
  });

  it('verifies the configured credential and rejects changed credentials', async () => {
    const config = loadOperatorAuthConfig(environment());
    expect(config).not.toBeNull();
    await expect(
      verifyOperatorPassword(config!, 'h5cs-admin', 'a-long-test-password'),
    ).resolves.toBe(true);
    await expect(
      verifyOperatorPassword(config!, 'other-admin', 'a-long-test-password'),
    ).resolves.toBe(false);
    await expect(verifyOperatorPassword(config!, 'h5cs-admin', 'wrong-password')).resolves.toBe(
      false,
    );
  });

  it('accepts only a signed unexpired operator session', () => {
    const config = loadOperatorAuthConfig(environment());
    expect(config).not.toBeNull();
    const now = Date.parse('2026-09-23T00:00:00.000Z');
    const token = createOperatorSession(config!, now);
    expect(resolveOperatorSession(config!, token, now)).toBe('h5cs-admin');
    expect(resolveOperatorSession(config!, `${token}x`, now)).toBeNull();
    expect(resolveOperatorSession(config!, token, now + 8 * 60 * 60 * 1_000)).toBeNull();
    expect(resolveOperatorSession(loadOperatorAuthConfig(environment())!, token, now)).toBeNull();
  });

  it('keys login throttling to a trusted IP without storing its plaintext value', () => {
    const config = loadOperatorAuthConfig(environment())!;
    const first = operatorLoginSourceDigest(config, '203.0.113.11');
    expect(first).toHaveLength(32);
    expect(first).toEqual(operatorLoginSourceDigest(config, '203.0.113.11'));
    expect(first).not.toEqual(operatorLoginSourceDigest(config, '203.0.113.12'));
    expect(operatorLoginSourceDigest(config, 'untrusted, 203.0.113.11')).toEqual(
      operatorLoginSourceDigest(config, null),
    );
  });
});
