import React, { isValidElement, type ReactNode, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A deterministic hook/event harness: no DOM dependency, HTTP and router are isolated.
const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  refresh: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useState<T>(initial: T) {
    const index = mocks.cursor++;
    if (!(index in mocks.hooks)) mocks.hooks[index] = initial;
    return [
      mocks.hooks[index],
      (next: T | ((previous: T) => T)) => {
        mocks.hooks[index] =
          typeof next === 'function' ? (next as (previous: T) => T)(mocks.hooks[index] as T) : next;
      },
    ];
  },
  useRef<T>(initial: T) {
    const index = mocks.cursor++;
    if (!(index in mocks.hooks)) mocks.hooks[index] = { current: initial };
    return mocks.hooks[index];
  },
  useEffect(effect: () => unknown, deps: unknown[]) {
    const index = mocks.cursor++;
    const previous = mocks.hooks[index] as unknown[] | undefined;
    if (!previous || deps.some((value, i) => value !== previous[i])) {
      mocks.hooks[index] = deps;
      mocks.effects.push(effect);
    }
  },
}));
import { MaterialManager } from './material-manager';

type Props = {
  children?: ReactNode;
  type?: string;
  role?: string;
  checked?: boolean;
  disabled?: boolean;
  value?: string;
  'aria-label'?: string;
  onClick?: () => unknown;
  onChange?: (event: { target: { checked: boolean; value?: string } }) => void;
};
const merchantId = 'aa'.repeat(16),
  assistantId = 'bb'.repeat(16),
  sourceId = 'dd'.repeat(16);
const first = {
  id: sourceId,
  name: '商品A.txt',
  text: 'A商品29元',
  size: 20,
  sha256: 'ef'.repeat(32),
  createdAt: '2026-10-21T00:00:00Z',
};
const second = { ...first, id: 'ee'.repeat(16), name: '商品B.txt', text: 'B商品39元' };
const defaultProps = {
  merchantId,
  assistantId,
  csrfToken: 'unit-csrf',
  revision: 3,
  materials: [first, second],
};
function render(props = defaultProps) {
  mocks.cursor = 0;
  const tree = MaterialManager(props);
  for (const effect of mocks.effects.splice(0)) effect();
  return tree;
}
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<Props>(node)) return text(node.props.children);
  return node == null || typeof node === 'boolean' ? '' : String(node);
}
function button(tree: ReactNode, label: string) {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node) === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
function checkbox(tree: ReactNode, label: string) {
  const parent = nodes(tree).find((node) => node.type === 'label' && text(node).includes(label));
  const found = nodes(parent).find(
    (node) => node.type === 'input' && node.props.type === 'checkbox',
  );
  if (!found) throw new Error(`Checkbox not found: ${label}`);
  return found;
}
function deletionButton(tree: ReactNode, name = first.name) {
  return nodes(tree).find(
    (node) => node.type === 'button' && node.props['aria-label'] === `删除材料：${name}`,
  )!;
}
const summary = (tree: ReactNode) => nodes(tree).find((node) => node.type === 'textarea')!;

describe('material deletion merchant experience', () => {
  beforeEach(() => {
    mocks.hooks = [];
    mocks.effects = [];
    mocks.cursor = 0;
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requires confirmation, explains snapshot/link behavior and lets cancellation retain material and summary', () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    tree = render();
    button(tree, '直接使用提取文字').props.onClick!();
    tree = render();
    const original = summary(tree).props.value;
    deletionButton(tree).props.onClick!();
    tree = render();
    expect(nodes(tree).find((node) => node.props.role === 'alertdialog')?.props['aria-label']).toBe(
      `删除材料：${first.name}`,
    );
    expect(text(tree)).toContain('不会自动修改已保存草稿、已发布客服或消费者链接');
    expect(button(tree, '保存整理稿到客服草稿').props.disabled).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
    button(tree, '取消').props.onClick!();
    tree = render();
    expect(summary(tree).props.value).toBe(original);
    expect(checkbox(tree, first.name).props.checked).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('removes only the deleted source, clears stale AI output/review/consent and refreshes after verified success', async () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    checkbox(tree, second.name).props.onChange!({ target: { checked: true } });
    tree = render();
    checkbox(tree, '我同意将所选材料').props.onChange!({ target: { checked: true } });
    tree = render();
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ summary: '旧AI整理稿', warnings: ['旧AI警告'] }),
    );
    button(tree, 'AI 整理所选材料').props.onClick!();
    await vi.waitFor(() => expect(summary(render()).props.value).toBe('旧AI整理稿'));
    tree = render();
    checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
    deletionButton(tree).props.onClick!();
    tree = render();
    mocks.fetch.mockResolvedValueOnce(Response.json({ deleted: true, sourceId }));
    button(tree, '确认删除材料').props.onClick!();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    tree = render();
    expect(deletionButton(tree)).toBeUndefined();
    expect(deletionButton(tree, second.name)).toBeDefined();
    expect(checkbox(tree, second.name).props.checked).toBe(true);
    expect(summary(tree).props.value).toBe('');
    expect(text(tree)).not.toContain('旧AI警告');
    expect(checkbox(tree, '我已核对整理稿').props.checked).toBe(false);
    expect(checkbox(tree, '我同意将所选材料').props.checked).toBe(false);
    expect(button(tree, '保存整理稿到客服草稿').props.disabled).toBe(true);
    expect(mocks.fetch).toHaveBeenLastCalledWith(
      `/${merchantId}/knowledge/${assistantId}/materials/delete`,
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
        headers: expect.objectContaining({ 'x-h5cs-csrf': 'unit-csrf' }),
        body: JSON.stringify({ sourceId, confirmed: true }),
      }),
    );
  });

  it.each(['failed', 'ambiguous', 'network'])(
    'preserves materials on %s deletion, reports refresh verification, and never retries',
    async (failure) => {
      let tree = render();
      deletionButton(tree).props.onClick!();
      tree = render();
      if (failure === 'network')
        mocks.fetch.mockRejectedValueOnce(new TypeError('network private'));
      else
        mocks.fetch.mockResolvedValueOnce(
          failure === 'failed'
            ? Response.json(
                { error: '未能确认删除结果，请刷新核对已保存材料后再操作；不会自动重试。' },
                { status: 503 },
              )
            : Response.json({ deleted: true, sourceId: second.id }),
        );
      button(tree, '确认删除材料').props.onClick!();
      await vi.waitFor(() =>
        expect(nodes(render()).some((node) => node.props.role === 'alert')).toBe(true),
      );
      tree = render();
      expect(deletionButton(tree)).toBeDefined();
      expect(text(tree)).toMatch(/请刷新|刷新核对/u);
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.fetch).toHaveBeenCalledOnce();
    },
  );

  it('drops stale selected source, summary and consent after a refreshed server list removes the source', () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    tree = render();
    button(tree, '直接使用提取文字').props.onClick!();
    tree = render();
    expect(summary(tree).props.value).toContain(first.text);
    const changed = { ...defaultProps, materials: [second] };
    render(changed);
    tree = render(changed);
    expect(summary(tree).props.value).toBe('');
    expect(button(tree, '直接使用提取文字').props.disabled).toBe(true);
    expect(checkbox(tree, '我同意将所选材料').props.checked).toBe(false);
  });
});
