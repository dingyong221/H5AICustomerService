export function safeMerchantReturnPath(merchantId: string, value: unknown): string | null {
  if (!/^[0-9a-f]{32}$/u.test(merchantId) || typeof value !== 'string') return null;
  const allowed = new RegExp(`^/workspace/${merchantId}(?:/assistants/[0-9a-f]{32})?$`, 'u');
  return allowed.test(value) ? value : null;
}
