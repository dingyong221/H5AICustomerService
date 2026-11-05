export type OfferTerms = Readonly<{ days: number | null; modelCalls: number | null }>;

export function offerTerms(offer: OfferTerms): string {
  const duration = offer.days === null ? '有效期暂不限' : `有效期${offer.days}天`;
  const calls =
    offer.modelCalls === null ? 'AI调用次数暂不限' : `包含${offer.modelCalls}次AI调用尝试`;
  return `${duration}，${calls}`;
}
