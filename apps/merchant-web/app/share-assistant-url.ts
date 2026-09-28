const publicPath = /^\/a\/[a-z0-9][a-z0-9-]{0,62}$/u;

export function safeShareAssistantUrl(value: string, expectedOrigin: string): string | null {
  if (value.length > 2_048) return null;
  try {
    const origin = new URL(expectedOrigin);
    const target = new URL(value);
    const loopback = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
    if (
      origin.origin !== expectedOrigin ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) ||
      target.origin !== origin.origin ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !publicPath.test(target.pathname)
    ) {
      return null;
    }
    return target.href;
  } catch {
    return null;
  }
}
