import { describe, expect, it } from 'vitest';

import { managementBaseUrl, merchantSetupUrl, merchantWorkspaceUrl } from './management-url';

describe('merchant management URL', () => {
  it('uses only the configured trusted origin and a validated merchant ID', () => {
    const base = managementBaseUrl('https://h5cs.1rying.com/');
    expect(base).not.toBeNull();
    expect(merchantWorkspaceUrl(base!, 'a'.repeat(32))).toBe(
      `https://h5cs.1rying.com/workspace/${'a'.repeat(32)}`,
    );
    expect(() => merchantWorkspaceUrl(base!, '../login')).toThrow('Merchant ID is invalid');
    expect(merchantSetupUrl(base!, 'opaque-token')).toBe(
      'https://h5cs.1rying.com/setup#opaque-token',
    );
  });

  it('keeps generated setup and workspace links under the dedicated console prefix', () => {
    const base = managementBaseUrl('https://h5cs.1rying.com/console');
    expect(base).not.toBeNull();
    expect(merchantSetupUrl(base!, 'opaque-token')).toBe(
      'https://h5cs.1rying.com/console/setup#opaque-token',
    );
    expect(merchantWorkspaceUrl(base!, 'a'.repeat(32))).toBe(
      `https://h5cs.1rying.com/console/workspace/${'a'.repeat(32)}`,
    );
  });

  it('rejects userinfo, an unapproved subpath, query, fragment and non-local cleartext', () => {
    for (const value of [
      'https://user:pass@h5cs.1rying.com/',
      'https://h5cs.1rying.com/admin',
      'https://h5cs.1rying.com/?next=elsewhere',
      'https://h5cs.1rying.com/#secret',
      'http://h5cs.1rying.com/',
      'javascript:alert(1)',
    ]) {
      expect(managementBaseUrl(value)).toBeNull();
    }
    expect(managementBaseUrl('http://127.0.0.1:3000/')).not.toBeNull();
  });
});
