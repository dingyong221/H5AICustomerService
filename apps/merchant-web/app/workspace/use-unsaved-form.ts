'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Protect in-memory merchant text without persisting business material in browser storage. */
export function useUnsavedForm(dirty: boolean) {
  const allowNavigation = useRef(false);
  useEffect(() => {
    allowNavigation.current = false;
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      if (allowNavigation.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    function beforeLink(event: MouseEvent) {
      if (
        allowNavigation.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self'))
        return;
      const url = new URL(link.href, window.location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      if (url.origin !== window.location.origin) return;
      if (
        url.origin === window.location.origin &&
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      )
        return;
      if (!window.confirm('当前有未保存的资料，离开将丢失。确定离开吗？')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', beforeLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', beforeLink, true);
    };
  }, [dirty]);
  return useCallback(() => {
    allowNavigation.current = true;
  }, []);
}
