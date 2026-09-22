import { describe, expect, it } from 'vitest';

import { loadTrustedWorkBuddyAuthorizationSnapshot } from './trusted-server-state';

const transactionRef = 'a'.repeat(64);

describe('trusted WorkBuddy authorization server state loader', () => {
  it('fails closed while no backend state source is wired', async () => {
    await expect(loadTrustedWorkBuddyAuthorizationSnapshot()).resolves.toEqual({
      status: 'backend_unavailable',
    });
  });

  it('accepts only a strict server authorization result', async () => {
    await expect(
      loadTrustedWorkBuddyAuthorizationSnapshot(async () => ({
        status: 'consent_required',
        transaction_ref: transactionRef,
      })),
    ).resolves.toEqual({
      status: 'consent_required',
      transaction_ref: transactionRef,
    });
  });

  it('does not turn query-shaped input, invalid refs, or errors into trusted state', async () => {
    await expect(
      loadTrustedWorkBuddyAuthorizationSnapshot(async () => ({
        code: 'untrusted-code',
        open_id: 'untrusted-subject',
        state: 'untrusted-state',
      })),
    ).resolves.toEqual({ status: 'backend_unavailable' });
    await expect(
      loadTrustedWorkBuddyAuthorizationSnapshot(async () => ({
        status: 'consent_required',
        transaction_ref: 'wrong-ref',
      })),
    ).resolves.toEqual({ status: 'backend_unavailable' });
    await expect(
      loadTrustedWorkBuddyAuthorizationSnapshot(async () => {
        throw new Error('route unavailable');
      }),
    ).resolves.toEqual({ status: 'backend_unavailable' });
  });
});
