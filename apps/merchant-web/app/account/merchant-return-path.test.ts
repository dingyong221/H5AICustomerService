import { describe, expect, it } from 'vitest';

import { safeMerchantReturnPath } from './merchant-return-path';

const merchantId = '22222222222222222222222222222222';
const assistantId = '44444444444444444444444444444444';

describe('merchant login return path', () => {
  it('allows only the authenticated merchant workspace and its assistant details', () => {
    expect(safeMerchantReturnPath(merchantId, `/workspace/${merchantId}`)).toBe(`/${merchantId}`);
    expect(
      safeMerchantReturnPath(merchantId, `/workspace/${merchantId}/assistants/${assistantId}`),
    ).toBe(`/${merchantId}/drafts/${assistantId}`);
    for (const section of ['drafts', 'knowledge', 'publish', 'conversations']) {
      expect(safeMerchantReturnPath(merchantId, `/${merchantId}/${section}`)).toBe(
        `/${merchantId}/${section}`,
      );
      expect(safeMerchantReturnPath(merchantId, `/${merchantId}/${section}/${assistantId}`)).toBe(
        `/${merchantId}/${section}/${assistantId}`,
      );
    }
  });

  it('rejects cross-merchant, query, fragment and external redirects', () => {
    for (const value of [
      `/workspace/33333333333333333333333333333333/assistants/${assistantId}`,
      `/33333333333333333333333333333333/knowledge/${assistantId}`,
      `/${merchantId}/publish/${assistantId}?token=secret`,
      `/${merchantId}/drafts/../knowledge`,
      `/${merchantId}/publish/not-an-id`,
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
