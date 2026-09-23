import type { AssistantDraftConfig } from '@h5cs/domain';

export function parseAssistantDraftForm(formData: FormData): AssistantDraftConfig | null {
  const field = (name: string, maximum: number, multiline = false): string | null => {
    const value = formData.get(name);
    if (typeof value !== 'string') return null;
    const normalized = (multiline ? value.replace(/\r\n?/gu, '\n') : value).trim();
    return normalized.length > 0 && normalized.length <= maximum &&
      !(multiline
        ? /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(normalized)
        : /[\u0000-\u001f\u007f]/u.test(normalized))
      ? normalized : null;
  };
  const industry = field('industry', 128);
  const businessScope = field('businessScope', 2_000, true);
  const materialsSummary = field('materialsSummary', 4_000, true);
  const pricingSummary = field('pricingSummary', 4_000, true);
  const promotionSummary = field('promotionSummary', 4_000, true);
  const welcomeMessage = field('welcomeMessage', 500);
  const insufficientInfoMessage = field('insufficientInfoMessage', 500);
  if (
    !industry || !businessScope || !materialsSummary || !pricingSummary ||
    !promotionSummary || !welcomeMessage || !insufficientInfoMessage
  ) return null;
  return {
    industry,
    businessScope,
    materialsSummary,
    pricingSummary,
    promotionSummary,
    welcomeMessage,
    insufficientInfoMessage,
  };
}
