const internalApiOrigin = 'http://api:4000';
const publicAssistantPath = '/api/v1/public/assistants/';

export function createServerPublicFetch(
  publicOrigin: string | undefined,
  configuredInternalOrigin: string | undefined,
  fetchImpl: typeof fetch = fetch,
): typeof fetch | undefined {
  if (configuredInternalOrigin === undefined) return undefined;
  if (configuredInternalOrigin !== internalApiOrigin || !publicOrigin) {
    throw new Error('Unsafe consumer server API configuration');
  }

  const canonicalOrigin = new URL(publicOrigin);
  if (
    canonicalOrigin.pathname !== '/' ||
    canonicalOrigin.search ||
    canonicalOrigin.hash ||
    canonicalOrigin.username ||
    canonicalOrigin.password ||
    (canonicalOrigin.protocol !== 'https:' &&
      !(canonicalOrigin.protocol === 'http:' && canonicalOrigin.hostname === '127.0.0.1'))
  ) {
    throw new Error('Unsafe consumer public origin');
  }

  return (input, init) => {
    const requested = new URL(String(input));
    const publicSlug = requested.pathname.slice(publicAssistantPath.length);
    if (
      requested.origin !== canonicalOrigin.origin ||
      !requested.pathname.startsWith(publicAssistantPath) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(publicSlug) ||
      requested.search ||
      requested.hash ||
      init?.method !== 'GET'
    ) {
      throw new Error('Unsafe consumer server API request');
    }
    const internalUrl = new URL(requested.pathname, internalApiOrigin);
    return fetchImpl(internalUrl, init);
  };
}
