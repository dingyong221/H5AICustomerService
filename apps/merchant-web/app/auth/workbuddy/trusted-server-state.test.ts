import { describe, expect, it } from 'vitest';

import { loadTrustedWorkBuddyAuthorizationSnapshot } from './trusted-server-state';

describe('trusted WorkBuddy authorization server state loader', () => {
  it('fails closed while no backend state route is wired', async () => {
    await expect(loadTrustedWorkBuddyAuthorizationSnapshot()).resolves.toEqual({
      stage: 'backend_unavailable',
    });
  });

  it('accepts a structured server source but never environment or query fallbacks', async () => {
    await expect(
      loadTrustedWorkBuddyAuthorizationSnapshot(async () => ({
        loginAction: { href: '/login/start' },
        stage: 'login_required',
      })),
    ).resolves.toEqual({
      loginAction: { href: '/login/start' },
      stage: 'login_required',
    });
  });

  it('fails closed for invalid, rejected, or unavailable server responses', async () => {
    await expect(
      loadTrustedWorkBuddyAuthorizationSnapshot(async () => ({
        code: 'untrusted-code',
        state: 'untrusted-state',
      })),
    ).resolves.toEqual({ stage: 'backend_unavailable' });
    await expect(
      loadTrustedWorkBuddyAuthorizationSnapshot(async () => {
        throw new Error('route unavailable');
      }),
    ).resolves.toEqual({ stage: 'backend_unavailable' });
  });
});
