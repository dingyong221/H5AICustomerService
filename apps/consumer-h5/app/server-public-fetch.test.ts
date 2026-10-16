import { describe, expect, it } from 'vitest';

import { loadPublicAssistantSnapshot } from './public-api-client';
import { createServerPublicFetch } from './server-public-fetch';

const publicOrigin = 'https://h5cs.example.com';
const internalOrigin = 'http://api:4000';

describe('consumer server-side public API fetch', () => {
  it('uses the ordinary same-origin fetch when no internal service is configured', () => {
    expect(createServerPublicFetch(publicOrigin, undefined)).toBeUndefined();
  });

  it('loads only the public assistant snapshot through the internal API service', async () => {
    const requestedUrls: string[] = [];
    const requestedHeaders: (HeadersInit | undefined)[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrls.push(String(input));
      requestedHeaders.push(init?.headers);
      return new Response(
        JSON.stringify({
          data: {
            aiDisclosure: true,
            assistantDisplayName: '测试客服',
            availability: 'online',
            businessScope: '家电清洗咨询',
            merchantDisplayName: '测试商家',
            publicAssistantId: 'assistant_public_1',
            releaseRef: 'release_1234567890',
            welcomeMessage: '您好',
          },
          request_id: 'request_1234567890',
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    };
    const result = await loadPublicAssistantSnapshot({
      apiBaseUrl: '/api/v1/public',
      fetchImpl: createServerPublicFetch(publicOrigin, internalOrigin, fetchImpl),
      origin: publicOrigin,
      publicSlug: 'test-assistant',
    });

    expect(result.status).toBe('online');
    expect(requestedUrls).toEqual(['http://api:4000/api/v1/public/assistants/test-assistant']);
    expect(new Headers(requestedHeaders[0]).get('X-H5CS-Features')).toBe('human-contact');
  });

  it('rejects an arbitrary internal destination or unsafe public origin', () => {
    expect(() => createServerPublicFetch(publicOrigin, 'http://127.0.0.1:4000')).toThrow();
    expect(() => createServerPublicFetch('http://example.com', internalOrigin)).toThrow();
  });

  it('rejects non-snapshot requests before reaching the internal service', () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('Internal service must not be reached');
    };
    const serverFetch = createServerPublicFetch(publicOrigin, internalOrigin, fetchImpl);
    expect(serverFetch).toBeDefined();
    expect(() =>
      serverFetch!(new URL('https://other.example.com/api/v1/public/assistants/test'), {
        method: 'GET',
      }),
    ).toThrow('Unsafe consumer server API request');
    expect(() =>
      serverFetch!(new URL(`${publicOrigin}/api/v1/public/assistants/test/sessions`), {
        method: 'GET',
      }),
    ).toThrow('Unsafe consumer server API request');
    expect(() =>
      serverFetch!(new URL(`${publicOrigin}/api/v1/public/assistants/test`), {
        method: 'POST',
      }),
    ).toThrow('Unsafe consumer server API request');
  });
});
