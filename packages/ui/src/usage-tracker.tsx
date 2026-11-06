'use client';
import { useEffect, useSyncExternalStore } from 'react';

const preference = 'kelaida_usage_optout';
function optedOut() {
  try {
    return (
      localStorage.getItem(preference) === '1' ||
      navigator.doNotTrack === '1' ||
      (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
    );
  } catch {
    return true;
  }
}
const controls = new Set([
  'navigation',
  'product.register',
  'register.submit',
  'login.submit',
  'invite.create',
  'invite.copy',
  'invite.qr',
  'draft.save',
  'knowledge.upload',
  'knowledge.organize',
  'knowledge.save',
  'preview.send',
  'preview.pass',
  'publish.confirm',
  'share.copy',
  'share.qr',
  'help.open',
  'writing.generate',
  'conversation.send',
  'conversation.new',
  'logout',
]);
export function usagePage(path: string): string {
  if (path.startsWith('/a/')) return 'consumer';
  if (path.startsWith('/ops')) return 'ops';
  if (path.includes('/product')) return 'product';
  if (path.includes('/marketplace')) return 'registration';
  if (path.includes('/login') || path.includes('/setup')) return 'login';
  const section = path.split('/')[2];
  return [
    'drafts',
    'knowledge',
    'preview',
    'publish',
    'conversations',
    'improvements',
    'writing',
    'help',
    'invite',
  ].includes(section ?? '')
    ? section!
    : /^\/[a-f0-9]{32}\/?$/u.test(path)
      ? 'workspace'
      : 'other';
}
export function usageActiveMs(visible: boolean, idleMs: number, elapsedMs: number) {
  return visible && idleMs <= 60000 ? Math.min(15000, Math.max(0, Math.round(elapsedMs))) : 0;
}
export function UsageTracker({ enabled, endpoint }: { enabled: boolean; endpoint: string }) {
  useEffect(() => {
    if (!enabled || typeof crypto.randomUUID !== 'function') return;
    type Event = {
      id: string;
      instance: string;
      event: string;
      page: string;
      control: string;
      activeMs: number;
      at: string;
    };
    let queue: Event[] = [],
      path = location.pathname,
      instance = crypto.randomUUID(),
      last = performance.now(),
      interaction = last,
      stopped = false,
      visible = document.visibilityState === 'visible';
    function add(event: string, control: string, activeMs = 0) {
      if (optedOut() || stopped) return;
      queue.push({
        id: crypto.randomUUID(),
        instance,
        event,
        page: usagePage(path),
        control,
        activeMs,
        at: new Date().toISOString(),
      });
      if (queue.length > 50) queue.splice(0, queue.length - 50);
    }
    function flush(beacon = false) {
      if (optedOut()) {
        queue = [];
        return;
      }
      if (!queue.length) return;
      const batch = queue.splice(0, 20),
        sentPath = path,
        ref = path.startsWith('/a/') ? path.split('/')[2] : undefined;
      const body = JSON.stringify({ events: batch, ...(ref ? { publicRef: ref } : {}) });
      if (beacon && typeof navigator.sendBeacon === 'function') {
        try {
          if (navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' })))
            return;
        } catch {
          /* Fall back to keepalive fetch if the browser rejects beacon delivery. */
        }
      }
      void fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'same-origin',
        keepalive: true,
      })
        .then((r) => {
          if (!r.ok && queue.length < 30 && path === sentPath) queue.unshift(...batch);
        })
        .catch(() => {
          if (queue.length < 30 && path === sentPath) queue.unshift(...batch);
        });
    }
    function tick() {
      const now = performance.now();
      const elapsed = usageActiveMs(visible, now - interaction, now - last);
      if (elapsed) add('active_time', 'clock', elapsed);
      last = now;
      visible = document.visibilityState === 'visible';
      if (location.pathname !== path) {
        flush(true);
        queue = [];
        path = location.pathname;
        instance = crypto.randomUUID();
        interaction = now;
        add('page_view', 'page');
      }
    }
    function interact() {
      if (location.pathname !== path) tick();
      interaction = performance.now();
    }
    function click(e: MouseEvent) {
      interact();
      const target =
        e.target instanceof Element
          ? e.target
          : e.target instanceof Node
            ? e.target.parentElement
            : null;
      const el = target?.closest('button,a');
      if (!el) return;
      const raw =
          el.getAttribute('data-usage') ??
          (el.tagName === 'BUTTON' ? el.closest('form')?.getAttribute('data-usage') : null),
        control =
          raw && controls.has(raw)
            ? raw
            : el.tagName === 'A'
              ? 'unregistered_link'
              : 'unregistered_button';
      add('control_click', control);
      flush(el.tagName === 'A' || (el instanceof HTMLButtonElement && el.type === 'submit'));
    }
    function submit(e: SubmitEvent) {
      if (location.pathname !== path) tick();
      const el = e.target as HTMLFormElement;
      const raw = el.getAttribute('data-usage');
      add('form_submit', raw && controls.has(raw) ? raw : 'unregistered_form');
      flush(true);
    }
    function hide() {
      tick();
      flush(true);
      last = performance.now();
    }
    function privacy() {
      if (optedOut()) queue = [];
    }
    add('page_view', 'page');
    flush();
    const clock = setInterval(() => {
        tick();
        flush();
      }, 15000),
      navigation = setInterval(() => {
        if (location.pathname !== path) tick();
      }, 1000);
    window.addEventListener('click', click, true);
    window.addEventListener('submit', submit, true);
    document.addEventListener('pointerdown', interact, { passive: true });
    document.addEventListener('keydown', interact);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', hide);
    window.addEventListener('storage', privacy);
    window.addEventListener('kelaida-privacy', privacy);
    return () => {
      tick();
      flush(true);
      stopped = true;
      clearInterval(clock);
      clearInterval(navigation);
      window.removeEventListener('click', click, true);
      window.removeEventListener('submit', submit, true);
      document.removeEventListener('pointerdown', interact);
      document.removeEventListener('keydown', interact);
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('storage', privacy);
      window.removeEventListener('kelaida-privacy', privacy);
    };
  }, [enabled, endpoint]);
  return null;
}
function preferenceSnapshot() {
  if (
    navigator.doNotTrack === '1' ||
    (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  )
    return 'browser';
  try {
    return localStorage.getItem(preference) === '1' ? 'off' : 'on';
  } catch {
    return 'unavailable';
  }
}
function subscribePreference(notify: () => void) {
  window.addEventListener('storage', notify);
  window.addEventListener('kelaida-privacy', notify);
  return () => {
    window.removeEventListener('storage', notify);
    window.removeEventListener('kelaida-privacy', notify);
  };
}
export function UsagePreference() {
  const state = useSyncExternalStore(subscribePreference, preferenceSnapshot, () => 'loading');
  return (
    <button
      type="button"
      disabled={state === 'loading' || state === 'browser' || state === 'unavailable'}
      onClick={() => {
        try {
          if (state !== 'on' && state !== 'off') return;
          localStorage.setItem(preference, state === 'off' ? '0' : '1');
          if (state === 'on')
            void fetch('/console/usage', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-usage-optout': '1' },
              body: '{}',
              credentials: 'same-origin',
            }).catch(() => undefined);
          window.dispatchEvent(new Event('kelaida-privacy'));
        } catch {
          window.dispatchEvent(new Event('kelaida-privacy'));
        }
      }}
    >
      {state === 'loading'
        ? '正在读取统计设置…'
        : state === 'browser'
          ? '浏览器隐私设置已关闭基础使用统计'
          : state === 'unavailable'
            ? '当前浏览器无法保存设置，基础使用统计已关闭'
            : state === 'off'
              ? '允许基础使用统计'
              : '关闭基础使用统计'}
    </button>
  );
}
