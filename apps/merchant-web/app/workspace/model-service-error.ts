const messages = {
  MARKETPLACE_QUOTA_EXHAUSTED: '本产品的 AI 服务额度已用尽，请联系运营核查；已保存的资料仍保留。',
  MARKETPLACE_NOT_ELIGIBLE: '本产品的服务资格已过期或暂停，请联系运营核查。',
} as const;
export class MarketplaceModelError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
  }
  get status(): 403 | 429 {
    return this.code === 'MARKETPLACE_QUOTA_EXHAUSTED' ? 429 : 403;
  }
}
export async function checkMarketplaceModelError(response: Response): Promise<void> {
  if (response.ok) return;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    body.error &&
    typeof body.error === 'object' &&
    'code' in body.error
  ) {
    const code = body.error.code;
    if (code === 'MARKETPLACE_QUOTA_EXHAUSTED' || code === 'MARKETPLACE_NOT_ELIGIBLE')
      throw new MarketplaceModelError(code);
  }
}
