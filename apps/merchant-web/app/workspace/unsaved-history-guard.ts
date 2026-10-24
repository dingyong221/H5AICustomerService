/** In-memory only: no merchant text, credentials or form values enter history/storage. */
const guards = new Set<() => boolean>();
const marker = '__h5csUnsavedNavigation';

export function registerUnsavedNavigationGuard(guard: () => boolean): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

export function hasUnsavedNavigation(): boolean {
  return [...guards].some((guard) => guard());
}

type Position = { scope: string; index: number };
/** Reuse the document's non-sensitive scope after a StrictMode/HMR boundary remount. */
export function unsavedHistoryScope(target: Window): string {
  const state: unknown = target.history.state;
  const value =
    typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[marker] : null;
  const scope =
    typeof value === 'object' && value !== null ? (value as Partial<Position>).scope : null;
  return typeof scope === 'string' && /^[A-Za-z0-9_-]{8,100}$/u.test(scope)
    ? scope
    : target.crypto.randomUUID();
}
const position = (state: unknown, scope: string): number | null => {
  if (typeof state !== 'object' || state === null) return null;
  const value: unknown = (state as Record<string, unknown>)[marker];
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Position;
  return candidate.scope === scope && Number.isSafeInteger(candidate.index) && candidate.index >= 0
    ? candidate.index
    : null;
};

/**
 * Index existing app history entries instead of adding duplicate sentinel entries.
 * A capture listener holds Next's popstate handler until the original position has
 * been restored. Only then ask, and traverse again if the user chooses to leave.
 * Cross-document navigation continues to use the browser's beforeunload prompt.
 */
export function installUnsavedHistoryGuard(
  target: Window,
  scope: string,
  isDirty: () => boolean = hasUnsavedNavigation,
): () => void {
  const history = target.history;
  const push = history.pushState;
  const replace = history.replaceState;
  let current = position(history.state, scope) ?? 0;
  let restoration: { from: number; to: number } | null = null;
  let permittedDestination: number | null = null;
  let disposed = false;

  const marked = (state: unknown, index: number) => ({
    ...(typeof state === 'object' && state !== null ? state : {}),
    [marker]: { scope, index },
  });
  // Preserve Next's own __NA/tree state and the current URL exactly.
  replace.call(history, marked(history.state, current), '');
  const indexedPush: History['pushState'] = function (state, unused, url) {
    if (disposed) return push.call(history, state, unused, url);
    const next = current + 1;
    push.call(history, marked(state, next), unused, url);
    current = next;
  };
  const indexedReplace: History['replaceState'] = function (state, unused, url) {
    if (disposed) return replace.call(history, state, unused, url);
    replace.call(history, marked(state, current), unused, url);
  };
  history.pushState = indexedPush;
  history.replaceState = indexedReplace;

  function onPop(event: PopStateEvent) {
    if (disposed) return;
    const destination = position(event.state, scope);
    // A different document/application has no indexed position in this scope.
    // Never fabricate a distance or create a history loop to trap its user.
    if (destination === null) return;

    if (restoration) {
      event.stopImmediatePropagation();
      const pending = restoration;
      if (destination !== pending.from) {
        history.go(pending.from - destination);
        return;
      }
      restoration = null;
      current = pending.from;
      if (!isDirty() || target.confirm('当前有未保存的资料，离开将丢失。确定离开吗？')) {
        permittedDestination = pending.to;
        history.go(pending.to - pending.from);
      }
      return;
    }

    if (permittedDestination === destination) {
      permittedDestination = null;
      current = destination;
      return;
    }
    permittedDestination = null;
    if (destination === current || !isDirty()) {
      current = destination;
      return;
    }

    event.stopImmediatePropagation();
    restoration = { from: current, to: destination };
    history.go(current - destination);
  }

  target.addEventListener('popstate', onPop, true);
  return () => {
    disposed = true;
    target.removeEventListener('popstate', onPop, true);
    if (history.pushState === indexedPush) history.pushState = push;
    if (history.replaceState === indexedReplace) history.replaceState = replace;
  };
}
