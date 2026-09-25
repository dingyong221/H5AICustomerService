export const managementBaseUrl = (value: string | undefined): URL | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

export const merchantWorkspaceUrl = (base: URL, merchantId: string): string => {
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) throw new Error('Merchant ID is invalid');
  return `${base.origin}/workspace/${merchantId}`;
};
