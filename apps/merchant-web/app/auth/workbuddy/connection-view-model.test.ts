import { describe, expect, it } from 'vitest';

import {
  buildWorkBuddyConnectionViewModel,
  resolveSecureAuthorizationEntry,
  secureAuthorizationLinkAttributes,
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

  it('provides page links with a strict no-referrer boundary', () => {
    expect(secureAuthorizationLinkAttributes).toEqual({
      referrerPolicy: 'no-referrer',
      rel: 'noreferrer',
    });
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

  it('treats code and state only as an untrusted callback pending server verification', () => {
    const model = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      callbackParameters: {
        code: 'sensitive-one-time-code',
        state: 'sensitive-correlation-state',
      },
      serverAuthorizationEntry: '/oauth/workbuddy/authorize',
    });

    expect(model.state).toBe('callback_pending');
    expect(JSON.stringify(model)).not.toContain('sensitive-one-time-code');
    expect(JSON.stringify(model)).not.toContain('sensitive-correlation-state');
    expect(model.authorizationHref).toBeUndefined();
  });

  it('does not turn provider errors into trusted authorization or merchant states', () => {
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

    expect(failed.state).toBe('callback_rejected');
    expect(JSON.stringify(failed)).not.toContain('provider-secret-error-value');
    expect(selection.state).toBe('callback_rejected');
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
      ).toBe('callback_rejected');
    }
  });

  it('shows signed-in only from a trusted server state, never from callback text', () => {
    expect(
      buildWorkBuddyConnectionViewModel({
        applicationOrigin,
        callbackParameters: { connected: 'true' },
        serverAuthorizationEntry: '/oauth/workbuddy/authorize',
      }).state,
    ).toBe('callback_rejected');

    expect(
      buildWorkBuddyConnectionViewModel({
        applicationOrigin,
        trustedServerState: 'signed_in',
      }),
    ).toMatchObject({ state: 'signed_in', label: '已登录' });
  });

  it('presents every trusted server state without allowing callbacks to override it', () => {
    const expectedLabels = {
      authorization_failed: '授权失败',
      binding_required: '需要绑定商家',
      conflict: '绑定冲突',
      consent_required: '需要授权同意',
      merchant_selection_required: '多商家待选择',
      revoked: '授权已撤销',
      signed_in: '已登录',
    } as const;

    for (const [trustedServerState, label] of Object.entries(expectedLabels)) {
      expect(
        buildWorkBuddyConnectionViewModel({
          applicationOrigin,
          callbackParameters: { error: 'untrusted-callback-error' },
          serverAuthorizationEntry: '/oauth/workbuddy/authorize?state=safe-state',
          trustedServerState: trustedServerState as keyof typeof expectedLabels,
        }),
      ).toMatchObject({ label, state: trustedServerState });
    }
  });
});
