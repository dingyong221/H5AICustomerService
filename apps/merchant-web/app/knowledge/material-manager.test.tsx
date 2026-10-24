import React, { isValidElement, type ReactNode, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A deterministic hook/event harness: no DOM dependency, HTTP and router are isolated.
const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  refresh: vi.fn(),
  push: vi.fn(),
  fetch: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));
vi.mock('../workspace/use-unsaved-form', () => ({ useUnsavedForm: () => () => {} }));
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
  hidden?: boolean;
  value?: string;
  'aria-label'?: string;
  onClick?: () => unknown;
  onChange?: (event: { target: { checked: boolean; value?: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void; currentTarget: unknown }) => void;
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
    mocks.confirm.mockReturnValue(true);
    vi.stubGlobal('window', { confirm: mocks.confirm });
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

  it('does not clear a new retained-material summary when delayed RSC props acknowledge an owned deletion', async () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    checkbox(tree, second.name).props.onChange!({ target: { checked: true } });
    tree = render();
    deletionButton(tree).props.onClick!();
    tree = render();
    mocks.fetch.mockResolvedValueOnce(Response.json({ deleted: true, sourceId }));
    button(tree, '确认删除材料').props.onClick!();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    // The delete acknowledgment is visible before the delayed server list.
    tree = render();
    expect(deletionButton(tree)).toBeUndefined();
    expect(checkbox(tree, second.name).props.checked).toBe(true);
    button(tree, '直接使用提取文字').props.onClick!();
    tree = render();
    const retainedSummary = summary(tree).props.value;
    expect(retainedSummary).toContain(second.text);
    expect(retainedSummary).not.toContain(first.text);
    checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
    const acknowledged = { ...defaultProps, materials: [second] };
    render(acknowledged);
    tree = render(acknowledged);
    expect(summary(tree).props.value).toBe(retainedSummary);
    expect(checkbox(tree, '我已核对整理稿').props.checked).toBe(true);
    expect(checkbox(tree, second.name).props.checked).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
  it('searches material text while preserving hidden selections and uses all selected sources, not only filtered rows', () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    checkbox(tree, second.name).props.onChange!({ target: { checked: true } });
    tree = render();
    const search = nodes(tree).find(
      (node) => node.type === 'input' && node.props.type === 'search',
    )!;
    search.props.onChange!({ target: { checked: false, value: 'B商品' } });
    tree = render();
    expect(deletionButton(tree, first.name)).toBeUndefined();
    expect(deletionButton(tree, second.name)).toBeDefined();
    button(tree, '直接使用提取文字').props.onClick!();
    tree = render();
    expect(summary(tree).props.value).toContain(first.text);
    expect(summary(tree).props.value).toContain(second.text);
    expect(text(tree)).toContain('筛选不会清除已选材料');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('appends a plain-language template without losing prior unsaved text or silently confirming it', () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    tree = render();
    button(tree, '直接使用提取文字').props.onClick!();
    tree = render();
    checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
    button(tree, '插入到整理稿').props.onClick!();
    tree = render();
    expect(summary(tree).props.value).toContain(first.text);
    expect(summary(tree).props.value).toContain('商品名称：待补充');
    expect(checkbox(tree, '我已核对整理稿').props.checked).toBe(false);
    expect(button(tree, '保存整理稿到客服草稿').props.disabled).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('still invalidates a new retained-material summary if the same refresh contains another external deletion', async () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    checkbox(tree, second.name).props.onChange!({ target: { checked: true } });
    tree = render();
    deletionButton(tree).props.onClick!();
    tree = render();
    mocks.fetch.mockResolvedValueOnce(Response.json({ deleted: true, sourceId }));
    button(tree, '确认删除材料').props.onClick!();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    tree = render();
    button(tree, '直接使用提取文字').props.onClick!();
    tree = render();
    expect(summary(tree).props.value).toContain(second.text);
    checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
    const externalRemoval = { ...defaultProps, materials: [] };
    render(externalRemoval);
    tree = render(externalRemoval);
    expect(summary(tree).props.value).toBe('');
    expect(checkbox(tree, '我已核对整理稿').props.checked).toBe(false);
    expect(button(tree, '保存整理稿到客服草稿').props.disabled).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('preserves an unsaved reviewed summary and warnings when more files are uploaded, without auto-merging facts', async () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    tree = render();
    checkbox(tree, '我同意将所选材料').props.onChange!({ target: { checked: true } });
    tree = render();
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ summary: '原有人工核对的整理稿', warnings: ['核对运费适用条件'] }),
    );
    button(tree, 'AI 整理所选材料').props.onClick!();
    await vi.waitFor(() => expect(summary(render()).props.value).toBe('原有人工核对的整理稿'));
    tree = render();
    checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
    tree = render();
    const NativeFormData = globalThis.FormData;
    vi.stubGlobal(
      'FormData',
      class extends NativeFormData {
        constructor() {
          super();
          this.append('files', new Blob(['新增资料']), '新增资料.txt');
        }
      },
    );
    mocks.fetch.mockResolvedValueOnce(Response.json({ saved: [second.id], errors: [] }));
    nodes(tree).find((node) => node.type === 'form')!.props.onSubmit!({
      preventDefault: vi.fn(),
      currentTarget: {},
    });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    tree = render();
    expect(summary(tree).props.value).toBe('原有人工核对的整理稿');
    expect(text(tree)).toContain('核对运费适用条件');
    expect(text(tree)).toContain('原有未保存整理稿已保留');
    expect(text(tree)).toContain('新增材料不会自动追加');
    expect(checkbox(tree, '我已核对整理稿').props.checked).toBe(false);
    expect(checkbox(tree, '我同意将所选材料').props.checked).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it.each([{}, { saved: false }, { saved: 'true' }])(
    'keeps all input and review on an ambiguous apply acknowledgement: %j',
    async (result) => {
      let tree = render();
      summary(tree).props.onChange!({ target: { checked: false, value: '未保存的真实商品资料' } });
      tree = render();
      checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
      tree = render();
      mocks.fetch.mockResolvedValueOnce(Response.json(result));
      nodes(tree)
        .filter((node) => node.type === 'form')
        .at(-1)!.props.onSubmit!({ preventDefault: vi.fn(), currentTarget: {} });
      await vi.waitFor(() => expect(text(render())).toContain('未能确认保存结果'));
      tree = render();
      expect(summary(tree).props.value).toBe('未保存的真实商品资料');
      expect(checkbox(tree, '我已核对整理稿').props.checked).toBe(true);
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(text(tree)).toContain('不会自动重试');
      expect(text(tree)).not.toContain('知识已保存到草稿');
    },
  );

  it('does not charge a model call or replace an unsaved summary when reorganization is cancelled', () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    tree = render();
    button(tree, '直接使用提取文字').props.onClick!();
    tree = render();
    const original = summary(tree).props.value;
    checkbox(tree, '我同意将所选材料').props.onChange!({ target: { checked: true } });
    tree = render();
    mocks.confirm.mockReturnValue(false);
    button(tree, 'AI 整理所选材料').props.onClick!();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(summary(render()).props.value).toBe(original);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before extraction text overwrites a different manual summary', () => {
    let tree = render();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    summary(tree).props.onChange!({ target: { checked: false, value: '手动填写并核对的内容' } });
    tree = render();
    mocks.confirm.mockReturnValue(false);
    button(tree, '直接使用提取文字').props.onClick!();
    expect(summary(render()).props.value).toBe('手动填写并核对的内容');
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.confirm.mockReturnValue(true);
    button(render(), '直接使用提取文字').props.onClick!();
    expect(summary(render()).props.value).toContain(first.text);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('explains uploaded versus effective knowledge and moves to review without another model request', () => {
    let tree = render();
    expect(text(tree)).toContain('上传不等于生效');
    expect(text(tree)).toContain('草稿有效资料：0 / 4000 字');
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    tree = render();
    button(tree, '直接使用提取文字').props.onClick!();
    tree = render();
    expect(summary(tree).props.value).toContain(first.text);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(
      nodes(tree).find(
        (node) =>
          node.type === 'div' &&
          node.props.hidden === false &&
          nodes(node).some((child) => child.type === 'textarea'),
      ),
    ).toBeDefined();
  });

  it('only continues to preview after a verified save and keeps an unknown save on this page', async () => {
    let tree = render();
    summary(tree).props.onChange!({ target: { checked: false, value: '核对后的商品事实' } });
    tree = render();
    checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
    tree = render();
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ saved: true }) });
    button(tree, '保存并进入效果试聊').props.onClick!();
    const saveForm = nodes(tree).find(
      (node) => node.type === 'form' && nodes(node).some((child) => child.type === 'textarea'),
    )!;
    saveForm.props.onSubmit!({ preventDefault: () => {}, currentTarget: {} });
    await vi.waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(`/${merchantId}/preview/${assistantId}`),
    );
    mocks.push.mockClear();
    summary(render()).props.onChange!({ target: { checked: false, value: '仍需保存的新资料' } });
    tree = render();
    checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
    tree = render();
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    button(tree, '保存并进入效果试聊').props.onClick!();
    nodes(tree).find(
      (node) => node.type === 'form' && nodes(node).some((child) => child.type === 'textarea'),
    )!.props.onSubmit!({ preventDefault: () => {}, currentTarget: {} });
    await vi.waitFor(() => expect(text(render())).toContain('未能确认保存结果'));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(summary(render()).props.value).toBe('仍需保存的新资料');
  });
});
