import { describe, expect, it } from 'vitest';

import { safeMerchantReturnPath } from './merchant-return-path';

const merchantId = '22222222222222222222222222222222';
const assistantId = '44444444444444444444444444444444';

describe('merchant login return path', () => {
  it('allows only the authenticated merchant workspace and its assistant details', () => {
    expect(safeMerchantReturnPath(merchantId, `/workspace/${merchantId}`)).toBe(
      `/workspace/${merchantId}`,
    );
    expect(
      safeMerchantReturnPath(merchantId, `/workspace/${merchantId}/assistants/${assistantId}`),
    ).toBe(`/workspace/${merchantId}/assistants/${assistantId}`);
  });

  it('rejects cross-merchant, query, fragment and external redirects', () => {
    for (const value of [
      `/workspace/33333333333333333333333333333333/assistants/${assistantId}`,
      `/workspace/${merchantId}/assistants/${assistantId}?token=secret`,
      `/workspace/${merchantId}#other`,
      '//example.invalid/workspace',
      'https://example.invalid/workspace',
      `/workspace/${merchantId}/assistants/../other`,
    ]) {
      expect(safeMerchantReturnPath(merchantId, value)).toBeNull();
    }
  });
});
