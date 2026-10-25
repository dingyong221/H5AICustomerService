import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionReference,
  readSessionReference,
  saveSessionReference,
  readBrowserSessionReference,
  saveBrowserSessionReference,
  clearBrowserSessionReference,
} from './session-reference';

const storage = () => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  } as Storage;
};

describe('session reference storage', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('restores the same reference after closing a tab while keeping merchant scopes separate', () => {
    const persistent = storage();
    vi.stubGlobal('window', { localStorage: persistent, sessionStorage: storage() });
    const ref = `session_request_${'12'.repeat(16)}`;
    saveBrowserSessionReference('merchant-a', ref);
    vi.stubGlobal('window', { localStorage: persistent, sessionStorage: storage() });
    expect(readBrowserSessionReference('merchant-a')).toBe(ref);
    expect(readBrowserSessionReference('merchant-b')).toBeNull();
    clearBrowserSessionReference('merchant-a');
    expect(readBrowserSessionReference('merchant-a')).toBeNull();
  });
  it('migrates a valid legacy tab reference but never persists a bearer session handle', () => {
    const persistent = storage(),
      tab = storage(),
      ref = `session_request_${'34'.repeat(16)}`;
    saveSessionReference(tab, 'merchant-a', ref);
    vi.stubGlobal('window', { localStorage: persistent, sessionStorage: tab });
    expect(readBrowserSessionReference('merchant-a')).toBe(ref);
    expect(readSessionReference(persistent, 'merchant-a')).toBe(ref);
    saveBrowserSessionReference('merchant-b', `s_${'ab'.repeat(16)}`);
    expect(readBrowserSessionReference('merchant-b')).toBeNull();
  });
  it('continues with per-tab storage when persistent storage is blocked', () => {
    const ref = `session_request_${'56'.repeat(16)}`;
    vi.stubGlobal('window', {
      get localStorage() {
        throw Error('blocked');
      },
      sessionStorage: storage(),
    });
    saveBrowserSessionReference('merchant-a', ref);
    expect(readBrowserSessionReference('merchant-a')).toBe(ref);
    clearBrowserSessionReference('merchant-a');
    expect(readBrowserSessionReference('merchant-a')).toBeNull();
  });
  it('stores only the scoped request ID, not the session handle', () => {
    const store = storage();
    const requestId = `session_request_${'11'.repeat(16)}`;
    saveSessionReference(store, 'a-one', requestId);
    expect(readSessionReference(store, 'a-one')).toBe(requestId);
    expect(readSessionReference(store, 'a-two')).toBeNull();
    clearSessionReference(store, 'a-one');
    expect(readSessionReference(store, 'a-one')).toBeNull();
  });

  it('rejects malformed references and tolerates disabled browser storage', () => {
    const denied = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readSessionReference(denied, 'a-one')).toBeNull();
    expect(() =>
      saveSessionReference(denied, 'a-one', `session_request_${'11'.repeat(16)}`),
    ).not.toThrow();
    expect(() => clearSessionReference(denied, 'a-one')).not.toThrow();
    expect(readSessionReference(storage(), '../escape')).toBeNull();
  });
});
