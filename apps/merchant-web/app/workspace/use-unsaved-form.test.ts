import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  effects: [] as (() => unknown)[],
  cleanups: [] as (() => unknown)[],
}));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => unknown) => {
    mocks.effects.push(effect);
  },
  useCallback: (callback: () => void) => callback,
}));
import { useUnsavedForm } from './use-unsaved-form';

const windowListeners = new Map<string, (event: unknown) => void>();
const documentListeners = new Map<string, (event: unknown) => void>();
const confirm = vi.fn();
let link: { href: string; target: string; hasAttribute: (name: string) => boolean };
class FakeElement {
  closest() {
    return link;
  }
}
function click(changed: Record<string, unknown> = {}) {
  const event = {
    target: new FakeElement(),
    button: 0,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...changed,
  };
  documentListeners.get('click')?.(event);
  return event;
}
function Activate(dirty = true) {
  const permit = useUnsavedForm(dirty);
  const cleanup = mocks.effects.splice(0).map((effect) => effect());
  for (const callback of cleanup)
    if (typeof callback === 'function') mocks.cleanups.push(callback as () => unknown);
  return { permit, cleanup };
}
describe('merchant unsaved-text navigation protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.effects = [];
    windowListeners.clear();
    documentListeners.clear();
    link = { href: 'https://merchant.test/a/knowledge/b', target: '', hasAttribute: () => false };
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('window', {
      location: {
        href: 'https://merchant.test/a/drafts/b',
        origin: 'https://merchant.test',
        pathname: '/a/drafts/b',
        search: '',
      },
      confirm,
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        windowListeners.set(name, handler),
      removeEventListener: (name: string) => windowListeners.delete(name),
    });
    vi.stubGlobal('document', {
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        documentListeners.set(name, handler),
      removeEventListener: (name: string) => documentListeners.delete(name),
    });
  });
  afterEach(() => {
    for (const callback of mocks.cleanups.splice(0)) callback();
    vi.unstubAllGlobals();
  });
  it('guards only dirty forms and removes listeners when the form unmounts', () => {
    Activate(false);
    expect(windowListeners.size + documentListeners.size).toBe(0);
    const { cleanup } = Activate();
    expect(windowListeners.has('beforeunload')).toBe(true);
    expect(documentListeners.has('click')).toBe(true);
    for (const callback of cleanup) if (typeof callback === 'function') callback();
    expect(windowListeners.size + documentListeners.size).toBe(0);
  });
  it('cancels ordinary in-app navigation after the user declines losing text', () => {
    Activate();
    confirm.mockReturnValue(false);
    const event = click();
    expect(confirm).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
  it('allows the user to leave deliberately without inventing or saving content', () => {
    Activate();
    confirm.mockReturnValue(true);
    expect(click().preventDefault).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
  });
  it('preserves modified clicks, new tabs, same-document anchors and external links', () => {
    Activate();
    click({ ctrlKey: true });
    click({ metaKey: true });
    click({ button: 1 });
    link.target = '_blank';
    click();
    link.target = '';
    link.href = 'https://merchant.test/a/drafts/b#help';
    click();
    link.href = 'https://other.test/guide';
    click();
    expect(confirm).not.toHaveBeenCalled();
  });
  it('warns on closing a dirty page, but permits navigation after a verified save', () => {
    const { permit } = Activate();
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    windowListeners.get('beforeunload')?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
    permit();
    click();
    windowListeners.get('beforeunload')?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });
});
