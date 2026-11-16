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
function render(props: Parameters<typeof MaterialManager>[0] = defaultProps) {
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

describe('persistent organization interactions (hook/events with mocked HTTP)', () => {
  const userId = 'ff'.repeat(16),
    taskId = '11'.repeat(16),
    requestId = `organize_${'22'.repeat(16)}`;
  const props = { ...defaultProps, asyncOrganization: true, recoveryScope: userId };
  const key = `h5cs:organization:${userId}:${merchantId}:${assistantId}`;
  const storage = new Map<string, string>();
  const task = {
    taskId,
    state: 'queued',
    inputRevision: 3,
    sources: [{ id: sourceId, revision: 1, contentHash: 'f'.repeat(64), name: first.name }],
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
    modelOutcome: 'none',
    stale: false,
    canRetry: false,
    canApply: false,
  };
  const complete = {
    ...task,
    state: 'completed',
    modelOutcome: 'succeeded',
    canApply: true,
    result: { summary: '商品A售价29元', warnings: ['请核对适用条件'] },
  };
  const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
  const draw = (overrides: Partial<typeof props> = {}) => render({ ...props, ...overrides });
  const saveForm = (tree: ReactNode) =>
    nodes(tree).find(
      (node) => node.type === 'form' && nodes(node).some((child) => child.type === 'textarea'),
    )!;
  async function start() {
    draw();
    let tree = draw();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    checkbox(tree, '我同意将所选材料').props.onChange!({ target: { checked: true } });
    tree = draw();
    button(tree, 'AI 整理所选材料').props.onClick!();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  }
  async function restore(value: unknown = complete, overrides: Partial<typeof props> = {}) {
    storage.set(key, JSON.stringify({ requestId, taskId }));
    mocks.fetch.mockResolvedValue(response(value));
    draw(overrides);
    await vi.waitFor(() => expect(text(draw(overrides))).toContain('来源草稿修订'));
    return draw(overrides);
  }
  beforeEach(() => {
    mocks.hooks = [];
    mocks.effects = [];
    mocks.cursor = 0;
    storage.clear();
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    vi.stubGlobal('fetch', mocks.fetch);
    vi.stubGlobal(
      'setInterval',
      vi.fn(() => 1),
    );
    vi.stubGlobal('clearInterval', vi.fn());
    mocks.confirm.mockReturnValue(true);
    vi.stubGlobal('window', {
      confirm: mocks.confirm,
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('persists one request before POST and prevents duplicate clicks from enqueuing twice', async () => {
    let resolve!: (value: unknown) => void;
    mocks.fetch.mockImplementation(() => {
      expect(JSON.parse(storage.get(key)!)).toHaveProperty('requestId');
      return new Promise((done) => {
        resolve = done;
      });
    });
    await start();
    const submitted = JSON.parse(mocks.fetch.mock.calls[0]![1].body as string);
    expect(submitted).toMatchObject({ sourceIds: [sourceId], revision: 3, consent: true });
    expect(submitted.requestId).toMatch(/^organize_[a-f0-9]{32}$/u);
    expect(mocks.fetch.mock.calls[0]![0]).toMatch(/\/organize-tasks$/u);
    expect(button(draw(), 'AI 整理所选材料').props.disabled).toBe(true);
    button(draw(), 'AI 整理所选材料').props.onClick!();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    resolve(response(task));
    await vi.waitFor(() => expect(text(draw())).toContain('正在排队'));
  });

  it('recovers an unknown POST after refresh only with GET using the exact persisted request ID', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('lost response'));
    await start();
    await vi.waitFor(() => expect(text(draw())).toContain('不会自动重新提交'));
    const pointer = JSON.parse(storage.get(key)!);
    mocks.hooks = [];
    mocks.effects = [];
    mocks.fetch.mockClear();
    mocks.fetch.mockResolvedValue(response(complete));
    draw();
    await vi.waitFor(() => expect(summary(draw()).props.value).toBe(complete.result.summary));
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0]![0]).toContain(`?requestId=${pointer.requestId}`);
    expect(mocks.fetch.mock.calls[0]![1]).not.toHaveProperty('method');
    expect(checkbox(draw(), '我已核对整理稿').props.checked).toBe(false);
  });

  it('does not overwrite human edits during polling, and adopts through task CAS only after confirmation', async () => {
    let tree = await restore();
    expect(button(tree, '保存整理稿到客服草稿').props.disabled).toBe(true);
    summary(tree).props.onChange!({ target: { checked: false, value: '人工核对后的商品事实' } });
    button(draw(), '刷新任务').props.onClick!();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    tree = draw();
    expect(summary(tree).props.value).toBe('人工核对后的商品事实');
    checkbox(tree, '我已核对整理稿').props.onChange!({ target: { checked: true } });
    tree = draw();
    mocks.fetch.mockResolvedValue(response({ saved: true, revision: 4 }));
    saveForm(tree).props.onSubmit!({ preventDefault: () => {}, currentTarget: {} });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    const call = mocks.fetch.mock.calls.at(-1)!;
    expect(call[0]).toContain(`/organize-tasks/${taskId}/apply`);
    expect(JSON.parse(call[1].body as string)).toEqual({
      summary: '人工核对后的商品事实',
      revision: 3,
      mode: 'append',
      confirmed: true,
    });
    expect(text(draw())).toContain('已保存至草稿修订 4');
    expect(button(draw(), '保存整理稿到客服草稿').props.disabled).toBe(true);
  });

  it.each([
    { ...complete, stale: true, canApply: false },
    { ...complete, inputRevision: 2 },
  ])(
    'blocks stale candidate adoption without detaching to the old manual endpoint',
    async (value) => {
      const tree = await restore(value);
      expect(text(tree)).toContain('候选已过期');
      expect(button(tree, '保存整理稿到客服草稿').props.disabled).toBe(true);
      expect(button(tree, '直接使用提取文字').props.disabled).toBe(true);
      saveForm(tree).props.onSubmit!({ preventDefault: () => {}, currentTarget: {} });
      expect(mocks.fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(['unknown', 'dispatched', 'succeeded'])(
    'never retries a failed task with unresolved model outcome %s',
    async (modelOutcome) => {
      const tree = await restore({ ...task, state: 'failed', modelOutcome, canRetry: true });
      expect(text(tree)).toContain('不能重试');
      expect(nodes(tree).some((node) => node.type === 'button' && text(node) === '重试整理')).toBe(
        false,
      );
      expect(button(tree, 'AI 整理所选材料').props.disabled).toBe(true);
      expect(mocks.fetch).toHaveBeenCalledOnce();
    },
  );

  it('allows an explicit retry for a server-approved definite failure with a new idempotency ID', async () => {
    const tree = await restore({
      ...task,
      state: 'failed',
      modelOutcome: 'failed',
      canRetry: true,
    });
    mocks.fetch.mockResolvedValue(response({ ...task, taskId: '33'.repeat(16) }));
    button(tree, '重试整理').props.onClick!();
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    const call = mocks.fetch.mock.calls[1]!;
    expect(call[0]).toContain(`/${taskId}/retry`);
    expect(JSON.parse(call[1].body as string).requestId).not.toBe(requestId);
  });

  it('keeps pending asynchronous work recoverable when admission is disabled instead of using sync fallback', async () => {
    let tree = await restore(task, { asyncOrganization: false });
    expect(button(tree, 'AI 整理所选材料').props.disabled).toBe(true);
    mocks.fetch.mockResolvedValue(response({ ...task, state: 'cancelled' }));
    button(tree, '取消整理').props.onClick!();
    await vi.waitFor(() =>
      expect(text(draw({ asyncOrganization: false }))).toContain('任务已取消'),
    );
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('仍可能计费'));
    tree = draw({ asyncOrganization: false });
    button(tree, '关闭已结束任务').props.onClick!();
    expect(storage.has(key)).toBe(false);
    expect(mocks.fetch.mock.calls.every(([url]) => String(url).includes('organize-tasks'))).toBe(
      true,
    );
  });

  it('freezes uncertain adoption content across refresh and reconciles the saved revision without another write', async () => {
    let tree = await restore();
    summary(tree).props.onChange!({ target: { checked: false, value: '本次人工确认内容' } });
    checkbox(draw(), '我已核对整理稿').props.onChange!({ target: { checked: true } });
    tree = draw();
    mocks.fetch.mockRejectedValueOnce(new TypeError('commit response lost'));
    saveForm(tree).props.onSubmit!({ preventDefault: () => {}, currentTarget: {} });
    await vi.waitFor(() => expect(text(draw())).toContain('保存结果待核对'));
    expect(JSON.parse(storage.get(key)!).pendingApply.summary).toBe('本次人工确认内容');
    expect(summary(draw()).props.disabled).toBe(true);
    mocks.hooks = [];
    mocks.effects = [];
    mocks.fetch.mockClear();
    mocks.fetch.mockResolvedValue(
      response({ ...complete, appliedRevision: 4, canApply: false, stale: true }),
    );
    draw();
    await vi.waitFor(() => expect(text(draw())).toContain('已保存至草稿修订 4'));
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0]![1]).not.toHaveProperty('method');
    expect(JSON.parse(storage.get(key)!)).not.toHaveProperty('pendingApply');
  });

  it('lets an explicitly confirmed stale pending adoption be abandoned locally after GET, including after reload', async () => {
    let tree = await restore();
    summary(tree).props.onChange!({
      target: { checked: false, value: '应保留到商家明确放弃的编辑稿' },
    });
    checkbox(draw(), '我已核对整理稿').props.onChange!({ target: { checked: true } });
    mocks.fetch.mockRejectedValueOnce(new TypeError('apply never committed; response unknown'));
    saveForm(draw()).props.onSubmit!({ preventDefault: () => {}, currentTarget: {} });
    await vi.waitFor(() => expect(text(draw())).toContain('保存结果待核对'));
    expect(nodes(draw()).some((node) => text(node) === '放弃待确认采纳并关闭')).toBe(false);
    mocks.hooks = [];
    mocks.effects = [];
    mocks.fetch.mockClear();
    mocks.fetch.mockResolvedValue(response({ ...complete, stale: true, canApply: false }));
    draw({ revision: 4 });
    await vi.waitFor(() => expect(text(draw({ revision: 4 }))).toContain('放弃待确认采纳并关闭'));
    tree = draw({ revision: 4 });
    expect(summary(tree).props.value).toBe('应保留到商家明确放弃的编辑稿');
    mocks.confirm.mockReturnValueOnce(false);
    button(tree, '放弃待确认采纳并关闭').props.onClick!();
    expect(storage.has(key)).toBe(true);
    expect(summary(draw({ revision: 4 })).props.value).toBe('应保留到商家明确放弃的编辑稿');
    button(draw({ revision: 4 }), '放弃待确认采纳并关闭').props.onClick!();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('请先复制需要保留的内容'));
    expect(storage.has(key)).toBe(false);
    expect(summary(draw({ revision: 4 })).props.value).toBe('');
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0]![1]).not.toHaveProperty('method');
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.hooks = [];
    mocks.effects = [];
    draw({ revision: 4 });
    expect(text(draw({ revision: 4 }))).not.toContain('保存结果待核对');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it.each(['read-failed', 'not-stale', 'already-applied'])(
    'does not offer pending-adoption abandonment for %s',
    async (state) => {
      storage.set(
        key,
        JSON.stringify({
          requestId,
          taskId,
          pendingApply: {
            revision: 3,
            summary: '待确认稿',
            mode: 'append',
            confirmed: true,
          },
        }),
      );
      mocks.fetch.mockResolvedValue(
        state === 'read-failed'
          ? { ok: false, status: 503, json: async () => ({}) }
          : response(
              state === 'already-applied'
                ? { ...complete, stale: true, appliedRevision: 4, canApply: false }
                : complete,
            ),
      );
      draw({ revision: 4 });
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(text(draw({ revision: 4 }))).toContain(
          state === 'read-failed'
            ? '未能确认任务状态'
            : state === 'already-applied'
              ? '已保存至草稿修订 4'
              : '候选已过期',
        ),
      );
      expect(
        nodes(draw({ revision: 4 })).some((node) => text(node) === '放弃待确认采纳并关闭'),
      ).toBe(false);
      expect(storage.has(key)).toBe(true);
    },
  );

  it('does not read another account recovery pointer or send a request when browser persistence fails', async () => {
    storage.set(key.replace(userId, '44'.repeat(16)), JSON.stringify({ requestId, taskId }));
    draw();
    draw();
    expect(mocks.fetch).not.toHaveBeenCalled();
    window.sessionStorage.setItem = () => {
      throw new Error('storage disabled');
    };
    let tree = draw();
    checkbox(tree, first.name).props.onChange!({ target: { checked: true } });
    checkbox(tree, '我同意将所选材料').props.onChange!({ target: { checked: true } });
    tree = draw();
    button(tree, 'AI 整理所选材料').props.onClick!();
    await vi.waitFor(() => expect(text(draw())).toContain('本次未发送'));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('reconciles an unrecorded submission and only replays the same request after an explicit click', async () => {
    mocks.fetch.mockRejectedValueOnce(new TypeError('connection lost before acceptance'));
    await start();
    await vi.waitFor(() => expect(text(draw())).toContain('不会自动重新提交'));
    const originalBody = mocks.fetch.mock.calls[0]![1].body;
    mocks.fetch.mockResolvedValueOnce(response(null));
    button(draw(), '刷新任务').props.onClick!();
    await vi.waitFor(() => expect(text(draw())).toContain('确认提交原任务'));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    mocks.fetch.mockResolvedValueOnce(response(task));
    button(draw(), '确认提交原任务').props.onClick!();
    await vi.waitFor(() => expect(text(draw())).toContain('正在排队'));
    expect(JSON.parse(mocks.fetch.mock.calls[2]![1].body as string)).toEqual(
      JSON.parse(originalBody as string),
    );
    expect(JSON.parse(storage.get(key)!)).not.toHaveProperty('submission');
  });

  it('keeps the new retry reference after a lost retry response and cannot close or retry the old task', async () => {
    const tree = await restore({
      ...task,
      state: 'failed',
      modelOutcome: 'failed',
      canRetry: true,
    });
    mocks.fetch.mockRejectedValueOnce(new TypeError('retry response lost'));
    button(tree, '重试整理').props.onClick!();
    await vi.waitFor(() => expect(text(draw())).toContain('不会自动重新提交'));
    const pointer = JSON.parse(storage.get(key)!);
    expect(pointer.submission.retryOf).toBe(taskId);
    expect(pointer.requestId).not.toBe(requestId);
    for (const label of ['重试整理', '关闭已结束任务'])
      expect(nodes(draw()).some((node) => node.type === 'button' && text(node) === label)).toBe(
        false,
      );
    mocks.fetch.mockResolvedValueOnce(response({ ...task, taskId: '33'.repeat(16) }));
    button(draw(), '刷新任务').props.onClick!();
    await vi.waitFor(() => expect(text(draw())).toContain('正在排队'));
    expect(mocks.fetch.mock.calls[2]![0]).toContain(`?requestId=${pointer.requestId}`);
  });

  it('blocks both sync fallback and asynchronous admission when a recovery record cannot be read', () => {
    storage.set(key, '{corrupt');
    draw({ asyncOrganization: false });
    const tree = draw({ asyncOrganization: false });
    expect(text(tree)).toContain('无法读取任务恢复记录');
    expect(button(tree, 'AI 整理所选材料').props.disabled).toBe(true);
    expect(button(tree, '保存整理稿到客服草稿').props.disabled).toBe(true);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('preserves edits but blocks adoption after an unreadable task until server access is verified again', async () => {
    const tree = await restore();
    summary(tree).props.onChange!({ target: { checked: false, value: '本地编辑仍保留' } });
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ code: 'NOT_FOUND' }),
    });
    button(draw(), '刷新任务').props.onClick!();
    await vi.waitFor(() => expect(text(draw())).toContain('未能确认任务状态'));
    expect(summary(draw()).props.value).toBe('本地编辑仍保留');
    expect(button(draw(), '保存整理稿到客服草稿').props.disabled).toBe(true);
    mocks.fetch.mockResolvedValueOnce(response(complete));
    button(draw(), '刷新任务').props.onClick!();
    await vi.waitFor(() => expect(text(draw())).not.toContain('未能确认任务状态'));
    expect(summary(draw()).props.value).toBe('本地编辑仍保留');
  });
});
