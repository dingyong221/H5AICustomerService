import { describe, expect, it, vi } from 'vitest';
import {
  hasUnsavedNavigation,
  installUnsavedHistoryGuard,
  registerUnsavedNavigationGuard,
  unsavedHistoryScope,
} from './unsaved-history-guard';

function fixture() {
  const entries: unknown[] = [{ __NA: true, tree: ['initial'] }];
  let index = 0;
  const listeners = new Set<(event: PopStateEvent) => void>();
  const moves: number[] = [];
  const confirm = vi.fn<(...args: string[]) => boolean>(() => false);
  const history = {
    get state() {
      return entries[index];
    },
    pushState: vi.fn((...args: unknown[]) => {
      entries.splice(index + 1);
      entries.push(args[0]);
      index++;
    }),
    replaceState: vi.fn((...args: unknown[]) => {
      entries[index] = args[0];
    }),
    go: vi.fn((delta: number) => {
      moves.push(delta);
    }),
  };
  const target = {
    history,
    confirm,
    addEventListener: vi.fn((_name: string, listener: (event: PopStateEvent) => void) =>
      listeners.add(listener),
    ),
    removeEventListener: vi.fn((_name: string, listener: (event: PopStateEvent) => void) =>
      listeners.delete(listener),
    ),
  } as unknown as Window;
  function pop(to: number) {
    index = to;
    const event = { state: entries[index], stopImmediatePropagation: vi.fn() };
    for (const listener of listeners) listener(event as unknown as PopStateEvent);
    return event;
  }
  return { target, entries, history, moves, confirm, pop, listeners };
}

describe('indexed unsaved history guard', () => {
  it('registers only callbacks, respects a verified save and unregisters', () => {
    let dirty = true;
    const unregister = registerUnsavedNavigationGuard(() => dirty);
    expect(hasUnsavedNavigation()).toBe(true);
    dirty = false;
    expect(hasUnsavedNavigation()).toBe(false);
    unregister();
    expect(hasUnsavedNavigation()).toBe(false);
  });

  it('preserves Next state and adds no sentinel/duplicate history entries', () => {
    const f = fixture();
    const push = f.history.pushState;
    const dispose = installUnsavedHistoryGuard(f.target, 'test', () => false);
    expect(f.entries).toHaveLength(1);
    expect(f.history.state).toMatchObject({ __NA: true, tree: ['initial'] });
    f.history.pushState({ __NA: true, tree: ['edit'] }, '', '/edit');
    expect(f.entries).toHaveLength(2);
    expect(f.history.state).toMatchObject({ __NA: true, tree: ['edit'] });
    dispose();
    expect(f.history.pushState).toBe(push);
    expect(f.listeners.size).toBe(0);
  });

  it('restores the dirty form before asking and declining never reaches router listeners', () => {
    const f = fixture();
    const dispose = installUnsavedHistoryGuard(f.target, 'test', () => true);
    f.target.history.pushState({}, '', '/edit');
    expect(f.pop(0).stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(f.moves).toEqual([1]);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.pop(1).stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.moves).toEqual([1]);
    expect(f.entries).toHaveLength(2);
    dispose();
  });

  it('confirmed multi-step back is replayed once and the router sees only the destination', () => {
    const f = fixture();
    const dispose = installUnsavedHistoryGuard(f.target, 'test', () => true);
    f.target.history.pushState({}, '', '/one');
    f.target.history.pushState({}, '', '/edit');
    f.confirm.mockReturnValue(true);
    f.pop(0);
    f.pop(2);
    expect(f.moves).toEqual([2, -2]);
    expect(f.pop(0).stopImmediatePropagation).not.toHaveBeenCalled();
    expect(f.confirm).toHaveBeenCalledOnce();
    dispose();
  });

  it('supports forward traversal and replaceState without growing history', () => {
    const f = fixture();
    let dirty = false;
    const dispose = installUnsavedHistoryGuard(f.target, 'test', () => dirty);
    f.target.history.pushState({}, '', '/edit');
    f.pop(0);
    f.target.history.replaceState({ __NA: true, tree: ['updated'] }, '', '/initial');
    dirty = true;
    f.pop(1);
    f.pop(0);
    expect(f.moves).toEqual([-1]);
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.entries).toHaveLength(2);
    dispose();
  });

  it('a save completed while restoring does not prompt or trap the user', () => {
    const f = fixture();
    let dirty = true;
    const dispose = installUnsavedHistoryGuard(f.target, 'test', () => dirty);
    f.target.history.pushState({}, '', '/edit');
    f.pop(0);
    dirty = false;
    f.pop(1);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.moves).toEqual([1, -1]);
    expect(f.pop(0).stopImmediatePropagation).not.toHaveBeenCalled();
    dispose();
  });

  it('does not guess positions for foreign history or store sensitive text', () => {
    const f = fixture();
    const dispose = installUnsavedHistoryGuard(f.target, 'test', () => true);
    f.entries.push({ __NA: true });
    const event = f.pop(1);
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(f.moves).toEqual([]);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(JSON.stringify(f.entries[0])).not.toContain('password');
    dispose();
  });

  it('a boundary remount retains the indexed scope and position instead of abandoning old entries', () => {
    const f = fixture();
    const initial = installUnsavedHistoryGuard(f.target, 'same-document-scope', () => true);
    f.target.history.pushState({}, '', '/edit');
    initial();
    expect(unsavedHistoryScope(f.target)).toBe('same-document-scope');
    const dispose = installUnsavedHistoryGuard(f.target, unsavedHistoryScope(f.target), () => true);
    f.pop(0);
    f.pop(1);
    expect(f.moves).toEqual([1]);
    expect(f.confirm).toHaveBeenCalledOnce();
    dispose();
  });

  it('an outer framework wrapper cannot revive disposed markers after reinstall', () => {
    const f = fixture();
    const first = installUnsavedHistoryGuard(f.target, 'first-scope', () => true);
    const capturedPush = f.target.history.pushState;
    const capturedReplace = f.target.history.replaceState;
    f.target.history.pushState = (...args) => capturedPush.apply(f.target.history, args);
    f.target.history.replaceState = (...args) => capturedReplace.apply(f.target.history, args);
    first();
    const dispose = installUnsavedHistoryGuard(f.target, 'second-scope', () => true);
    f.target.history.pushState({ __NA: true }, '', '/edit');
    expect(unsavedHistoryScope(f.target)).toBe('second-scope');
    expect(f.entries).toHaveLength(2);
    f.pop(0);
    f.pop(1);
    expect(f.confirm).toHaveBeenCalledOnce();
    dispose();
  });
});
