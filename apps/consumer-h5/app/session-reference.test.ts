import { describe, expect, it } from 'vitest';

import {
  clearSessionReference,
  readSessionReference,
  saveSessionReference,
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
