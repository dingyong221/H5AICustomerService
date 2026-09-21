import { describe, expect, it } from 'vitest';

import {
  buildWorkBuddyConnectionViewModel,
  decodeTrustedWorkBuddyAuthorizationSnapshot,
  resolveSecureServerNavigation,
  secureAuthorizationLinkAttributes,
  type TrustedWorkBuddyAuthorizationSnapshot,
  type WorkBuddyMerchantCandidate,
} from './connection-view-model';

const applicationOrigin = 'https://merchant.example.com';
const merchantOne: WorkBuddyMerchantCandidate = {
  displayName: '蓝天家电服务',
  reference: 'merchant_ref_one',
  roleLabel: '管理员',
};
const merchantTwo: WorkBuddyMerchantCandidate = {
  displayName: '青山维修',
  reference: 'merchant_ref_two',
  roleLabel: '所有者',
};

const merchantResolution = (
  merchants: readonly WorkBuddyMerchantCandidate[],
): TrustedWorkBuddyAuthorizationSnapshot => ({
  connectorLabel: 'H5 AI Customer Service',
  merchants,
  scope: 'mcp:tools',
  stage: 'merchant_resolution_required',
});

describe('WorkBuddy trusted authorization page state', () => {
  it('fails closed when no trusted server snapshot or backend route exists', () => {
    const model = buildWorkBuddyConnectionViewModel({ applicationOrigin });

    expect(model).toMatchObject({
      actionLabel: '等待可信服务端路由',
      blocked: true,
      label: '授权后端不可用',
      state: 'backend_unavailable',
    });
    expect(model.authorizationHref).toBeUndefined();
    expect(model.steps.every((step) => step.status === 'blocked')).toBe(true);
  });

  it('accepts only same-origin server navigation and strips unsafe routes', () => {
    expect(
      resolveSecureServerNavigation({
        applicationOrigin,
        navigation: { href: '/login/start?transaction=opaque_ref' },
      }),
    ).toBe('https://merchant.example.com/login/start?transaction=opaque_ref');
    expect(
      resolveSecureServerNavigation({
        applicationOrigin: 'http://127.0.0.1:3000',
        navigation: { href: '/auth/workbuddy/start' },
      }),
    ).toBe('http://127.0.0.1:3000/auth/workbuddy/start');

    for (const href of [
      'http://merchant.example.com/login',
      'https://foreign.example/login',
      'https://user:password@merchant.example.com/login',
      'https://merchant.example.com/login#token',
      'https://merchant.example.com/oauth/token',
      '/auth/workbuddy/callback?code=one-time-code',
      '/auth/workbuddy/callback?state=correlation-secret',
      '/auth/workbuddy/callback?open_id=identifier',
    ]) {
      expect(
        resolveSecureServerNavigation({
          applicationOrigin,
          navigation: { href },
        }),
      ).toBeUndefined();
    }
  });

  it('keeps strict no-referrer attributes on every enabled navigation', () => {
    expect(secureAuthorizationLinkAttributes).toEqual({
      referrerPolicy: 'no-referrer',
      rel: 'noreferrer',
    });
  });

  it('uses query presence only for a fixed notice and never for authorization state', () => {
    const model = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      trustedServerSnapshot: {
        loginAction: { href: '/login/start' },
        stage: 'login_required',
      },
      untrustedCallbackPresent: true,
    });

    expect(model.state).toBe('login_required');
    expect(model.authorizationHref).toBe('https://merchant.example.com/login/start');
    expect(model.securityNotice).toContain('不会改变登录、绑定、商家或授权状态');
    expect(JSON.stringify(model)).not.toContain('code=');
    expect(JSON.stringify(model)).not.toContain('open_id');
  });

  it('presents login then binding only from trusted server snapshots', () => {
    const login = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      trustedServerSnapshot: {
        loginAction: { href: '/login/start' },
        stage: 'login_required',
      },
    });
    const binding = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      trustedServerSnapshot: {
        accountLabel: '账号尾号 4821',
        bindingAction: { href: '/auth/workbuddy/start' },
        stage: 'binding_required',
      },
    });

    expect(login).toMatchObject({ blocked: false, state: 'login_required' });
    expect(login.steps.map((step) => step.status)).toEqual([
      'current',
      'pending',
      'pending',
      'pending',
    ]);
    expect(binding).toMatchObject({ blocked: false, state: 'binding_required' });
    expect(binding.steps.map((step) => step.status)).toEqual([
      'complete',
      'current',
      'pending',
      'pending',
    ]);
  });

  it('fails closed for zero merchants and never invents a tenant', () => {
    const model = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      trustedServerSnapshot: merchantResolution([]),
    });

    expect(model).toMatchObject({
      blocked: true,
      merchants: [],
      state: 'merchant_access_required',
    });
    expect(model.consent).toBeUndefined();
    expect(model.authorizationHref).toBeUndefined();
  });

  it('turns exactly one trusted merchant into a consent state without auto-approval', () => {
    const snapshot = merchantResolution([merchantOne]);
    if (snapshot.stage !== 'merchant_resolution_required') throw new Error('Unexpected fixture');
    const model = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      trustedServerSnapshot: {
        ...snapshot,
        singleMerchantConsentAction: { href: '/auth/workbuddy/consent' },
      },
    });

    expect(model).toMatchObject({
      actionLabel: '查看并同意授权',
      authorizationHref: 'https://merchant.example.com/auth/workbuddy/consent',
      blocked: false,
      consent: {
        connectorLabel: 'H5 AI Customer Service',
        merchantDisplayName: '蓝天家电服务',
        scope: 'mcp:tools',
      },
      state: 'consent_required',
    });
    expect(model.consent?.permissions).toHaveLength(4);
  });

  it('requires an explicit choice for multiple trusted merchants and has no default', () => {
    const model = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      trustedServerSnapshot: merchantResolution([
        {
          ...merchantOne,
          selectionAction: { href: '/auth/workbuddy/merchant/merchant_ref_one' },
        },
        {
          ...merchantTwo,
          selectionAction: { href: 'https://foreign.example/merchant_ref_two' },
        },
      ]),
    });

    expect(model.state).toBe('merchant_selection_required');
    expect(model.authorizationHref).toBeUndefined();
    expect(model.merchants).toEqual([
      {
        displayName: '蓝天家电服务',
        reference: 'merchant_ref_one',
        roleLabel: '管理员',
        selectionHref: 'https://merchant.example.com/auth/workbuddy/merchant/merchant_ref_one',
      },
      {
        displayName: '青山维修',
        reference: 'merchant_ref_two',
        roleLabel: '所有者',
      },
    ]);
    expect(model.blocked).toBe(false);
  });

  it('shows consent details but remains blocked without a consent submission route', () => {
    const model = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      trustedServerSnapshot: {
        connectorLabel: 'H5 AI Customer Service',
        merchant: merchantOne,
        scope: 'mcp:tools',
        stage: 'consent_required',
      },
    });

    expect(model).toMatchObject({
      blocked: true,
      state: 'consent_required',
    });
    expect(model.authorizationHref).toBeUndefined();
    expect(model.steps.map((step) => step.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'current',
    ]);
  });

  it('shows authorized only from a trusted snapshot and still validates management navigation', () => {
    const model = buildWorkBuddyConnectionViewModel({
      applicationOrigin,
      trustedServerSnapshot: {
        connectorLabel: 'H5 AI Customer Service',
        managementAction: { href: '/' },
        merchant: merchantOne,
        stage: 'authorized',
      },
      untrustedCallbackPresent: true,
    });

    expect(model.state).toBe('authorized');
    expect(model.authorizationHref).toBeUndefined();
    expect(model.blocked).toBe(true);
    expect(model.steps.every((step) => step.status === 'complete')).toBe(true);
  });

  it('decodes only bounded trusted state shapes and rejects ambiguous merchants', () => {
    expect(
      decodeTrustedWorkBuddyAuthorizationSnapshot({
        connectorLabel: 'H5 AI Customer Service',
        merchants: [merchantOne],
        scope: 'mcp:tools',
        stage: 'merchant_resolution_required',
      }),
    ).toMatchObject({ stage: 'merchant_resolution_required' });
    expect(
      decodeTrustedWorkBuddyAuthorizationSnapshot({
        connectorLabel: 'H5 AI Customer Service',
        merchants: [merchantOne, merchantOne],
        scope: 'mcp:tools',
        stage: 'merchant_resolution_required',
      }),
    ).toBeUndefined();
    expect(
      decodeTrustedWorkBuddyAuthorizationSnapshot({
        connectorLabel: 'H5 AI Customer Service',
        merchant: { ...merchantOne, reference: '../other-merchant' },
        scope: 'mcp:tools',
        stage: 'consent_required',
      }),
    ).toBeUndefined();
    expect(
      decodeTrustedWorkBuddyAuthorizationSnapshot({
        connected: true,
        stage: 'authorized',
      }),
    ).toBeUndefined();
  });
});
