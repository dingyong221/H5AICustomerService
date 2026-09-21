import { describe, expect, it } from 'vitest';

import {
  buildWorkBuddyConnectionViewModel,
  resolveSecureAuthorizationEntry,
} from './connection-view-model';

const applicationOrigin = 'https://merchant.example.com';

describe('WorkBuddy connection security boundary', () => {
  it('stays unconfigured without a server-provided authorization entry', () => {
    const model = buildWorkBuddyConnectionViewModel({ applicationOrigin });
    expect(model.state).toBe('unconfigured');
    expect(model.authorizationHref).toBeUndefined();
  });

  it('accepts only same-origin or explicitly allowed HTTPS authorization entries', () => {
    expect(
      resolveSecureAuthorizationEntry({
        applicationOrigin,
        serverAuthorizationEntry: '/oauth/workbuddy/authorize?state=safe-state',
      }),
    ).toBe('https://merchant.example.com/oauth/workbuddy/authorize?state=safe-state');

    expect(
      resolveSecureAuthorizationEntry({
        allowedAuthorizationOrigins: ['https://auth.workbuddy.example'],
        applicationOrigin,
        serverAuthorizationEntry: 'https://auth.workbuddy.example/oauth/authorize',
      }),
    ).toBe('https://auth.workbuddy.example/oauth/authorize');

    for (const unsafeEntry of [
      'http://merchant.example.com/oauth/authorize',
      'https://foreign.example/oauth/authorize',
      'https://user:password@merchant.example.com/oauth/authorize',
      'https://merchant.example.com/oauth/authorize#token',
      'https://merchant.example.com/oauth/authorize?code=one-time-code',
      'https://merchant.example.com/oauth/authorize?access_token=secret',
      'https://merchant.example.com/oauth/authorize?open_id=identifier',
    ]) {
      expect(
        resolveSecureAuthorizationEntry({
          applicationOrigin,
          serverAuthorizationEntry: unsafeEntry,
        }),
      ).toBeUndefined();
    }
  });

  it('shows disconnected only when a validated authorization entry is available', () => {
    expect(
      buildWorkBuddyConnectionViewModel({
        applicationOrigin,
        serverAuthorizationEntry: '/oauth/workbuddy/authorize?state=safe-state',
      }),
    ).toMatchObject({
      authorizationHref: 'https://merchant.example.com/oauth/workbuddy/authorize?state=safe-state',
      label: '尚未连接',
      state: 'disconnected',
    });
  });

  it('treats code and state as binding pending without echoing either value', () => {
    const model = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      callbackParameters: {
        code: 'sensitive-one-time-code',
        state: 'sensitive-correlation-state',
      },
      serverAuthorizationEntry: '/oauth/workbuddy/authorize',
    });

    expect(model.state).toBe('binding_pending');
    expect(JSON.stringify(model)).not.toContain('sensitive-one-time-code');
    expect(JSON.stringify(model)).not.toContain('sensitive-correlation-state');
    expect(model.authorizationHref).toBeUndefined();
  });

  it('classifies authorization failure and multi-merchant selection without echoing errors', () => {
    const failed = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      callbackParameters: { error: 'provider-secret-error-value' },
      serverAuthorizationEntry: '/oauth/workbuddy/authorize',
    });
    const selection = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      callbackParameters: { error: 'merchant_selection_required' },
      serverAuthorizationEntry: '/oauth/workbuddy/authorize',
    });

    expect(failed.state).toBe('authorization_failed');
    expect(JSON.stringify(failed)).not.toContain('provider-secret-error-value');
    expect(selection.state).toBe('merchant_selection_required');
  });

  it('rejects unknown, repeated, incomplete and oversized callback parameters', () => {
    const cases = [
      { access_token: 'secret' },
      { code: ['one', 'two'], state: 'expected' },
      { code: 'only-code' },
      { code: 'x'.repeat(2_049), state: 'expected' },
      { connected: 'true' },
    ];

    for (const callbackParameters of cases) {
      expect(
        buildWorkBuddyConnectionViewModel({
          applicationOrigin,
          callbackParameters,
          serverAuthorizationEntry: '/oauth/workbuddy/authorize',
        }).state,
      ).toBe('authorization_failed');
    }
  });

  it('shows connected only from a trusted server state, never from callback text', () => {
    expect(
      buildWorkBuddyConnectionViewModel({
        applicationOrigin,
        callbackParameters: { connected: 'true' },
        serverAuthorizationEntry: '/oauth/workbuddy/authorize',
      }).state,
    ).toBe('authorization_failed');

    expect(
      buildWorkBuddyConnectionViewModel({
        applicationOrigin,
        trustedServerState: 'connected',
      }),
    ).toMatchObject({ state: 'connected', label: '已连接' });
  });
});
