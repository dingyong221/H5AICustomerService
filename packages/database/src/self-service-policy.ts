export type SelfServicePolicy = Readonly<{
  origin: string;
  campaign: string;
  days: number;
  modelCalls: number;
  maxClaims: number;
}>;

/** A server-owned free offer. No price, subject, quota or entitlement is accepted from a URL. */
export function selfServicePolicy(
  environment: NodeJS.ProcessEnv = process.env,
): SelfServicePolicy | null {
  if (environment['H5CS_MARKETPLACE_MODE'] !== 'public-free') return null;
  try {
    const value = environment['MERCHANT_PUBLIC_ORIGIN'];
    const url = new URL(value ?? '');
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(local && url.protocol === 'http:' && environment['NODE_ENV'] !== 'production'))
    )
      return null;
    const integer = (key: string, maximum: number) => {
      const text = environment[key] ?? '';
      if (!/^[1-9][0-9]*$/u.test(text)) throw new Error('Missing finite free offer');
      const number = Number(text);
      if (!Number.isSafeInteger(number) || number > maximum) throw new Error('Invalid free offer');
      return number;
    };
    const campaign = environment['H5CS_FREE_CAMPAIGN'] ?? '';
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(campaign)) return null;
    return {
      origin: url.origin,
      campaign,
      days: integer('H5CS_FREE_DAYS', 365),
      modelCalls: integer('H5CS_FREE_MODEL_CALLS', 10000),
      maxClaims: integer('H5CS_FREE_MAX_CLAIMS', 10000),
    };
  } catch {
    return null;
  }
}
