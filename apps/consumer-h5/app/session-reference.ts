const requestPattern = /^session_request_[0-9a-f]{32}$/u;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;

function keyFor(publicSlug: string): string | null {
  return slugPattern.test(publicSlug) ? `h5cs:session-request:${publicSlug}` : null;
}

export function readSessionReference(storage: Storage, publicSlug: string): string | null {
  const key = keyFor(publicSlug);
  if (!key) return null;
  try {
    const value = storage.getItem(key);
    return value && requestPattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveSessionReference(
  storage: Storage,
  publicSlug: string,
  sessionRequestId: string,
): void {
  const key = keyFor(publicSlug);
  if (!key || !requestPattern.test(sessionRequestId)) return;
  try {
    storage.setItem(key, sessionRequestId);
  } catch {
    // Storage can be unavailable in private modes; the current conversation still works.
  }
}

export function clearSessionReference(storage: Storage, publicSlug: string): void {
  const key = keyFor(publicSlug);
  if (!key) return;
  try {
    storage.removeItem(key);
  } catch {
    // The server still validates the HttpOnly visitor cookie and session expiry.
  }
}
