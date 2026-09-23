import { randomBytes, scryptSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createOperatorSession,
  loadOperatorAuthConfig,
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
    expect(loadOperatorAuthConfig({ ...values, OPS_PUBLIC_ORIGIN: 'http://ops.example.test' })).toBeNull();
  });

  it('verifies the configured credential and rejects changed credentials', () => {
    const config = loadOperatorAuthConfig(environment());
    expect(config).not.toBeNull();
    expect(verifyOperatorPassword(config!, 'h5cs-admin', 'a-long-test-password')).toBe(true);
    expect(verifyOperatorPassword(config!, 'other-admin', 'a-long-test-password')).toBe(false);
    expect(verifyOperatorPassword(config!, 'h5cs-admin', 'wrong-password')).toBe(false);
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
});
