import { describe, expect, it } from 'vitest';

import {
  buildWorkBuddyConnectionViewModel,
  resolveWorkBuddyAuthorizationUrl,
  secureAuthorizationLinkAttributes,
} from './connection-view-model';

const transactionRef = 'a'.repeat(64);

describe('WorkBuddy trusted authorization page state', () => {
  it('fails closed without a trusted server result', () => {
    const model = buildWorkBuddyConnectionViewModel({});

    expect(model).toMatchObject({
      blocked: true,
      canContinue: false,
      label: '授权后端不可用',
      state: 'backend_unavailable',
    });
    expect(model.steps.every((step) => step.status === 'blocked')).toBe(true);
  });

  it('shows login only from a trusted sign-in-required response', () => {
    const model = buildWorkBuddyConnectionViewModel({
      trustedServerSnapshot: { status: 'sign_in_required' },
      untrustedCallbackPresent: true,
    });

    expect(model.state).toBe('login_required');
    expect(model.securityNotice).toContain('提交给服务端验证');
    expect(model.steps.map((step) => step.status)).toEqual([
      'current',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('allows only the fixed WorkBuddy authorization endpoint and no sensitive response data', () => {
    const authorizationUrl =
      'https://www.workbuddy.cn/openapi/v2/oauth/authorize?client_id=client&state=opaque';
    const model = buildWorkBuddyConnectionViewModel({
      trustedServerSnapshot: {
        authorization_url: authorizationUrl,
        status: 'signed_in',
        transaction_ref: transactionRef,
      },
    });

    expect(model).toMatchObject({
      authorizationHref: authorizationUrl,
      blocked: false,
      state: 'workbuddy_authorization_required',
      transactionRef,
    });
    for (const unsafe of [
      'http://www.workbuddy.cn/openapi/v2/oauth/authorize?state=opaque',
      'https://foreign.example/openapi/v2/oauth/authorize?state=opaque',
      'https://www.workbuddy.cn/openapi/v2/token',
      'https://www.workbuddy.cn/openapi/v2/oauth/authorize?code=secret',
      'https://www.workbuddy.cn/openapi/v2/oauth/authorize?open_id=identity',
    ]) {
      expect(resolveWorkBuddyAuthorizationUrl(unsafe)).toBeUndefined();
    }
    expect(secureAuthorizationLinkAttributes).toEqual({
      referrerPolicy: 'no-referrer',
      rel: 'noreferrer',
    });
  });

  it('stops when zero merchants are available', () => {
    const bindingRequired = buildWorkBuddyConnectionViewModel({
      trustedServerSnapshot: { status: 'binding_required', transaction_ref: transactionRef },
    });
    const emptyCandidates = buildWorkBuddyConnectionViewModel({
      trustedServerSnapshot: {
        candidates: [],
        status: 'merchant_selection_required',
        transaction_ref: transactionRef,
      },
    });

    expect(bindingRequired).toMatchObject({
      blocked: true,
      state: 'merchant_access_required',
      transactionRef,
    });
    expect(emptyCandidates.state).toBe('merchant_access_required');
    expect(emptyCandidates.merchants).toEqual([]);
  });

  it('never defaults one or multiple server candidates', () => {
    for (const candidates of [
      [{ candidate_ref: 'merchant_one', display_name: '蓝天家电服务' }],
      [
        { candidate_ref: 'merchant_one', display_name: '蓝天家电服务' },
        { candidate_ref: 'merchant_two', display_name: '青山维修' },
      ],
    ]) {
      const model = buildWorkBuddyConnectionViewModel({
        trustedServerSnapshot: {
          candidates,
          status: 'merchant_selection_required',
          transaction_ref: transactionRef,
        },
      });

      expect(model.state).toBe('merchant_selection_required');
      expect(model.merchants).toHaveLength(candidates.length);
      expect(model.transactionRef).toBe(transactionRef);
      expect(model.consent).toBeUndefined();
    }
  });

  it('requires explicit consent for the exact server transaction', () => {
    const model = buildWorkBuddyConnectionViewModel({
      trustedServerSnapshot: { status: 'consent_required', transaction_ref: transactionRef },
    });

    expect(model).toMatchObject({
      canConsent: true,
      consent: {
        merchantDisplayName: '服务端已锁定的单一商家',
        scope: 'mcp:tools',
      },
      state: 'consent_required',
      transactionRef,
    });
    expect(model.consent?.permissions).toHaveLength(4);
  });

  it('enables continue-use only after a trusted connected response', () => {
    const connected = buildWorkBuddyConnectionViewModel({
      trustedServerSnapshot: { status: 'connected' },
    });
    const failed = buildWorkBuddyConnectionViewModel({
      trustedServerSnapshot: { status: 'authorization_failed' },
    });

    expect(connected).toMatchObject({
      canContinue: true,
      state: 'authorized',
    });
    expect(connected.steps.every((step) => step.status === 'complete')).toBe(true);
    expect(failed).toMatchObject({ canContinue: false, canRetry: true, canStart: true });
    expect(failed.steps.every((step) => step.status === 'blocked')).toBe(true);
  });
});
