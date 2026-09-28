export const managementBaseUrl = (value: string | undefined): URL | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !['/', '/console', '/console/'].includes(url.pathname) ||
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

const managementPath = (base: URL, path: string): string => {
  const prefix = base.pathname === '/' ? '' : '/console';
  return `${base.origin}${prefix}${path}`;
};

export const merchantSetupUrl = (base: URL, token: string): string =>
  `${managementPath(base, '/setup')}#${token}`;

export const merchantWorkspaceUrl = (base: URL, merchantId: string): string => {
  if (!/^[0-9a-f]{32}$/u.test(merchantId)) throw new Error('Merchant ID is invalid');
  return managementPath(base, `/workspace/${merchantId}`);
};
