export function merchantBasePath(): '' | '/console' {
  const configured = process.env.NEXT_PUBLIC_MERCHANT_BASE_PATH;
  if (configured === undefined || configured === '') return '';
  if (configured === '/console') return '/console';
  throw new Error('Invalid merchant base path');
}

export function relativeMerchantPath(pathname: string): string | null {
  const prefix = merchantBasePath();
  if (!prefix) return pathname;
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : null;
}
