import { describe, expect, it } from 'vitest';
import { selfServicePolicy } from '../src/self-service-policy.js';
const env = {
  H5CS_MARKETPLACE_MODE: 'public-free',
  MERCHANT_PUBLIC_ORIGIN: 'https://h5cs.1rying.com',
  H5CS_FREE_CAMPAIGN: 'pilot-v1',
  H5CS_FREE_DAYS: '30',
  H5CS_FREE_MODEL_CALLS: '100',
  H5CS_FREE_MAX_CLAIMS: '100',
};
describe('server-owned public free offer', () => {
  it('requires deliberate finite configuration for every resource dimension', () => {
    expect(selfServicePolicy({})).toBeNull();
    expect(selfServicePolicy(env)).toMatchObject({ days: 30, modelCalls: 100, maxClaims: 100 });
    for (const key of ['H5CS_FREE_DAYS', 'H5CS_FREE_MODEL_CALLS', 'H5CS_FREE_MAX_CLAIMS']) {
      for (const value of ['', '0', '-1', 'Infinity', '9999999999', '1.5'])
        expect(selfServicePolicy({ ...env, [key]: value })).toBeNull();
    }
  });
  it('does not turn the synthetic adapter or an invalid origin into a public offer', () => {
    expect(selfServicePolicy({ ...env, H5CS_MARKETPLACE_MODE: 'local-fixture' })).toBeNull();
    for (const origin of [
      'http://h5cs.1rying.com',
      'https://h5cs.1rying.com/claim',
      'https://u:p@h5cs.1rying.com',
      'https://h5cs.1rying.com/',
    ])
      expect(selfServicePolicy({ ...env, MERCHANT_PUBLIC_ORIGIN: origin })).toBeNull();
    expect(
      selfServicePolicy({
        ...env,
        NODE_ENV: 'production',
        MERCHANT_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
      }),
    ).toBeNull();
  });
  it('supports only an explicit unlimited token and retains independently bounded dimensions', () => {
    expect(
      selfServicePolicy({
        ...env,
        H5CS_FREE_DAYS: 'unlimited',
        H5CS_FREE_MODEL_CALLS: 'unlimited',
        H5CS_FREE_MAX_CLAIMS: 'unlimited',
      }),
    ).toMatchObject({ days: null, modelCalls: null, maxClaims: null });
    expect(selfServicePolicy({ ...env, H5CS_FREE_MODEL_CALLS: 'unlimited' })).toMatchObject({
      days: 30,
      modelCalls: null,
      maxClaims: 100,
    });
    expect(selfServicePolicy({ ...env, H5CS_FREE_DAYS: 'UNLIMITED' })).toBeNull();
  });
});
