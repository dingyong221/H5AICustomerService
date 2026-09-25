import { describe, expect, it } from 'vitest';

import { managementBaseUrl, merchantWorkspaceUrl } from './management-url';

describe('merchant management URL', () => {
  it('uses only the configured trusted origin and a validated merchant ID', () => {
    const base = managementBaseUrl('https://h5cs.1rying.com/');
    expect(base).not.toBeNull();
    expect(merchantWorkspaceUrl(base!, 'a'.repeat(32))).toBe(
      `https://h5cs.1rying.com/workspace/${'a'.repeat(32)}`,
    );
    expect(() => merchantWorkspaceUrl(base!, '../login')).toThrow('Merchant ID is invalid');
  });

  it('rejects userinfo, a subpath, query, fragment and non-local cleartext', () => {
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
