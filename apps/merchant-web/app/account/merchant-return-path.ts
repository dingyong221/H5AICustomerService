export function safeMerchantReturnPath(merchantId: string, value: unknown): string | null {
  if (!/^[0-9a-f]{32}$/u.test(merchantId) || typeof value !== 'string') return null;
  const allowed = new RegExp(
    `^/${merchantId}(?:/(?:drafts|knowledge|publish|conversations)(?:/[0-9a-f]{32})?|/(?:writing|help))?$`,
    'u',
  );
  if (allowed.test(value)) return value;
  const improvements = new RegExp(
    `^/${merchantId}/improvements(?:/[0-9a-f]{32})?(?:\\?assistant=[0-9a-f]{32}(?:&session=[0-9a-f]{32}&message=[0-9a-f]{32})?)?(?:#create)?$`,
    'u',
  );
  if (improvements.test(value)) return value;
  if (value === `/workspace/${merchantId}`) return `/${merchantId}`;
  const legacy = new RegExp(`^/workspace/${merchantId}/assistants/([0-9a-f]{32})$`, 'u').exec(
    value,
  );
  return legacy ? `/${merchantId}/drafts/${legacy[1]}` : null;
}
