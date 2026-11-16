import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeControlView } from '@h5cs/contracts';
const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  action: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('./runtime-control-actions', () => ({ controlRuntime: mocks.action }));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useState<T>(initial: T) {
    const i = mocks.cursor++;
    if (!(i in mocks.hooks)) mocks.hooks[i] = initial;
    return [
      mocks.hooks[i],
      (value: T) => {
        mocks.hooks[i] = value;
      },
    ];
  },
  useRef<T>(initial: T) {
    const i = mocks.cursor++;
    if (!(i in mocks.hooks)) mocks.hooks[i] = { current: initial };
    return mocks.hooks[i];
  },
  useEffect(effect: () => unknown, deps: unknown[]) {
    const i = mocks.cursor++;
    const old = mocks.hooks[i] as unknown[] | undefined;
    if (!old || deps.some((v, j) => v !== old[j])) {
      mocks.hooks[i] = deps;
      mocks.effects.push(effect);
    }
  },
}));
import { RuntimeControlForm, runtimeStateLabel } from './runtime-control-form';
const scope = { kind: 'global' as const };
const view: RuntimeControlView = {
  scope,
  scopeKey: 'global',
  enabled: true,
  state: 'active',
  revision: '2',
  changedAt: null,
  actorId: null,
  reason: null,
  lastRequestId: null,
  effectiveState: 'runnable',
  blockingScopes: [],
};
const request = {
  scope,
  action: 'pause',
  expectedRevision: '2',
  requestId: `runtime_${'a'.repeat(32)}`,
  reason: '核对模型供应商异常',
  confirmed: true,
};
const key = 'h5cs:runtime-control:operator:global';
type Props = {
  children?: ReactNode;
  disabled?: boolean;
  onClick?: () => unknown;
  onSubmit?: (event: { preventDefault: () => void; currentTarget: unknown }) => void;
};
const nodes = (node: ReactNode): ReactElement<Props>[] =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : isValidElement<Props>(node)
      ? [node, ...nodes(node.props.children)]
      : [];
const text = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(text).join('')
    : isValidElement<Props>(node)
      ? text(node.props.children)
      : node == null || typeof node === 'boolean'
        ? ''
        : String(node);
let storage: Map<string, string>;
function render(overrides: Partial<Parameters<typeof RuntimeControlForm>[0]> = {}) {
  mocks.cursor = 0;
  const tree = RuntimeControlForm({
    view,
    scope,
    label: '全局',
    operatorId: 'operator',
    ...overrides,
  });
  for (const effect of mocks.effects.splice(0)) effect();
  return tree;
}
function submit(tree: ReactNode, values = { reason: request.reason, confirmed: 'yes' }) {
  nodes(tree)
    .find((node) => node.type === 'form')
    ?.props.onSubmit?.({ preventDefault() {}, currentTarget: values });
}
function button(tree: ReactNode, label: string) {
  const node = nodes(tree).find((n) => n.type === 'button' && text(n) === label);
  if (!node) throw Error(`Missing ${label}`);
  return node;
}
beforeEach(() => {
  mocks.hooks = [];
  mocks.effects = [];
  mocks.cursor = 0;
  vi.clearAllMocks();
  storage = new Map();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, value: string) => storage.set(k, value),
      removeItem: (k: string) => storage.delete(k),
    },
  });
  vi.stubGlobal(
    'FormData',
    class {
      constructor(private values: Record<string, string>) {}
      get(name: string) {
        return this.values[name] ?? null;
      }
    },
  );
  mocks.action.mockResolvedValue({ error: null, uncertain: false, receipt: null, current: view });
});
afterEach(() => vi.unstubAllGlobals());
describe('runtime control component with explicit hook/events and mocked server action', () => {
  it.each([null, { ...view, enabled: false }, { ...view, effectiveState: 'unavailable' as const }])(
    'disables writes before or without a verified enabled snapshot',
    (value) => {
      render({ view: value });
      const tree = render({ view: value });
      expect(nodes(tree).find((node) => node.type === 'fieldset')?.props.disabled).toBe(true);
      submit(tree);
      expect(mocks.action).not.toHaveBeenCalled();
    },
  );
  it('confirmation and reason are required before dispatch, and storage is saved before the action', async () => {
    render();
    submit(render(), { reason: request.reason, confirmed: '' });
    expect(mocks.action).not.toHaveBeenCalled();
    mocks.action.mockImplementation(async () => {
      expect(JSON.parse(storage.get(key)!)).toMatchObject({
        scope,
        expectedRevision: '2',
        reason: request.reason,
        confirmed: true,
      });
      return { error: '待确认', uncertain: true, receipt: null, current: null };
    });
    submit(render());
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalledOnce());
    expect(text(render())).toContain('查询原操作收据及当前状态');
    expect(text(render())).not.toContain('本范围允许运行');
  });
  it('double clicks dispatch only once while the first action is pending', () => {
    render();
    mocks.action.mockReturnValue(new Promise(() => {}));
    const tree = render();
    submit(tree);
    submit(tree);
    expect(mocks.action).toHaveBeenCalledOnce();
  });
  it('restores lost-response record after remount and only looks up the same key even if current control read failed', async () => {
    storage.set(key, JSON.stringify(request));
    render({ view: null });
    let tree = render({ view: null });
    expect(nodes(tree).some((node) => node.type === 'form')).toBe(false);
    expect(mocks.action).not.toHaveBeenCalled();
    mocks.action.mockResolvedValue({
      error: '尚未查到',
      uncertain: true,
      receipt: null,
      current: view,
    });
    button(tree, '查询原操作收据及当前状态').props.onClick!();
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalledExactlyOnceWith(request, true));
    tree = render({ view: null });
    expect(text(tree)).toContain(request.requestId);
    expect(JSON.parse(storage.get(key)!).requestId).toBe(request.requestId);
  });
  it('failed storage prevents dispatch and explicitly reports that nothing was sent', async () => {
    render();
    window.sessionStorage.setItem = () => {
      throw Error('quota');
    };
    submit(render());
    await vi.waitFor(() => expect(text(render())).toContain('本次未发送'));
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it('distinguishes historical receipt from later current state and requires explicit refresh before another operation', async () => {
    storage.set(key, JSON.stringify(request));
    render();
    mocks.action.mockResolvedValue({
      error: null,
      uncertain: false,
      receipt: { action: 'pause', revision: '3', changedAt: '2026-11-17T00:00:00Z' },
      current: { ...view, revision: '4' },
    });
    button(render(), '查询原操作收据及当前状态').props.onClick!();
    await vi.waitFor(() => expect(text(render())).toContain('当前修订 4'));
    const tree = render();
    expect(text(tree)).toContain('这是该次历史收据');
    expect(nodes(tree).find((node) => node.type === 'fieldset')?.props.disabled).toBe(true);
    expect(storage.has(key)).toBe(false);
    button(tree, '刷新当前状态后再操作').props.onClick!();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.action).toHaveBeenCalledOnce();
  });
  it('never reads a different operator or scope recovery record as authorization', () => {
    storage.set(key, JSON.stringify(request));
    render({ operatorId: 'other' });
    const tree = render({ operatorId: 'other' });
    expect(text(tree)).not.toContain(request.requestId);
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it('makes inherited pause and business-state distinction explicit', () => {
    expect(
      runtimeStateLabel({
        ...view,
        effectiveState: 'paused',
        blockingScopes: [{ kind: 'global' }],
      }),
    ).toContain('仍受上级暂停');
    const tree = render();
    expect(text(tree)).toContain('区别于商家业务停用');
    expect(text(tree)).toContain('固定链接保留');
  });
});
