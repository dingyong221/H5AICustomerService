export type MerchantSection =
  'drafts' | 'knowledge' | 'publish' | 'conversations' | 'writing' | 'help';

export function merchantPath(
  merchantId: string,
  section?: MerchantSection,
  reference?: string,
): string {
  if (!/^[0-9a-f]{32}$/u.test(merchantId) || (reference && !/^[0-9a-f]{32}$/u.test(reference))) {
    throw new Error('Invalid merchant route');
  }
  return `/${merchantId}${section ? `/${section}` : ''}${reference ? `/${reference}` : ''}`;
}
