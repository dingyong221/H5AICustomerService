import React, { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveDraftState } from './knowledge-actions';

const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  state: { saved: false, error: null } as SaveDraftState,
  pending: false,
  push: vi.fn(),
  refresh: vi.fn(),
  permit: vi.fn(),
  guard: vi.fn(),
  fetch: vi.fn(),
}));
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
  useId: () => 'unit-field',
  useActionState: () => [mocks.state, () => undefined, mocks.pending],
  useSyncExternalStore: () => true,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock('./knowledge-actions', () => ({ saveAssistantDraftAction: vi.fn() }));
vi.mock('./use-unsaved-form', () => ({
  useUnsavedForm: (dirty: boolean) => {
    mocks.guard(dirty);
    return mocks.permit;
  },
}));
import { CreateAssistantForm } from './create-assistant-form';
import { EditDraftForm } from './edit-draft-form';
import { DraftFields } from '../writing/draft-fields';

type Props = {
  children?: ReactNode;
  name?: string;
  value?: string | number;
  disabled?: boolean;
  open?: boolean;
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: unknown) => Promise<void>;
  onInvalid?: (event: unknown) => void;
  values?: Record<string, string>;
  onChangeField?: unknown;
};
const merchantId = 'a'.repeat(32),
  assistantId = 'b'.repeat(32);
const draft = {
  industry: '家居零售',
  businessScope: '解答毛巾选购',
  materialsSummary: '纯棉毛巾，规格待确认。',
  pricingSummary: '29元/条，运费需确认。',
  promotionSummary: '暂无优惠',
  welcomeMessage: '您好，请提问。',
  insufficientInfoMessage: '此信息需商家确认。',
};
const editProps = {
  merchantId,
  assistantId,
  draftRevision: 2,
  draft,
  csrfToken: 'csrf',
  continueHref: `/${merchantId}/knowledge/${assistantId}`,
};
const createProps = {
  merchantId,
  idempotencyKey: 'unit-idempotency',
  templates: [],
  templatesReady: true,
  csrfToken: 'csrf',
};
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
function renderEdit(props = editProps) {
  mocks.cursor = 0;
  const tree = EditDraftForm(props);
  for (const effect of mocks.effects.splice(0)) effect();
  return tree;
}
function renderCreate() {
  mocks.cursor = 0;
  const tree = CreateAssistantForm(createProps);
  for (const effect of mocks.effects.splice(0)) effect();
  return tree;
}
function button(tree: ReactNode, label: string) {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node) === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}
function fields(tree: ReactNode) {
  return nodes(tree).find((node) => node.type === DraftFields)!;
}
describe('concise draft forms and saved navigation', () => {
  beforeEach(() => {
    mocks.hooks = [];
    mocks.cursor = 0;
    mocks.effects = [];
    mocks.state = { saved: false, error: null };
    mocks.pending = false;
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('groups all submitted fields into three independent expandable sections with explicit labels', () => {
    mocks.cursor = 0;
    const tree = DraftFields({
      merchantId,
      csrfToken: 'csrf',
      values: { displayName: '客服', ...draft },
      includeName: true,
      onChange: vi.fn(),
      responseFields: <textarea name="humanContact" />,
    });
    const groups = nodes(tree).filter((node) => node.type === 'details');
    expect(
      groups.map((node) => text(nodes(node).find((child) => child.type === 'summary'))),
    ).toEqual(['基本资料', '交易规则', '回复设置']);
    expect(groups.map((node) => node.props.open)).toEqual([true, false, false]);
    expect(
      nodes(tree)
        .filter((node) => ['input', 'textarea'].includes(String(node.type)))
        .map((node) => node.props.name),
    ).toEqual([
      'displayName',
      'industry',
      'businessScope',
      'materialsSummary',
      'pricingSummary',
      'promotionSummary',
      'welcomeMessage',
      'insufficientInfoMessage',
      'humanContact',
    ]);
  });
  it('opens a collapsed group before native validation focuses its field', () => {
    mocks.cursor = 0;
    const tree = DraftFields({
      merchantId,
      csrfToken: 'csrf',
      values: { displayName: '', ...draft },
      onChange: vi.fn(),
    });
    const pricing = nodes(tree).find((node) => node.props.name === 'pricingSummary')!;
    const group = { open: false };
    pricing.props.onInvalid!({ currentTarget: { closest: () => group } });
    expect(group.open).toBe(true);
  });
  it('saves before continuing, does not navigate on failure, and deduplicates successful effects', () => {
    let tree = renderEdit();
    button(tree, '保存并继续').props.onClick!();
    expect(mocks.push).not.toHaveBeenCalled();
    mocks.state = { saved: false, error: '保存失败' };
    tree = renderEdit();
    expect(text(tree)).toContain('保存失败');
    expect(mocks.push).not.toHaveBeenCalled();
    mocks.state = { saved: true, error: null };
    renderEdit();
    renderEdit();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(editProps.continueHref);
    expect(mocks.permit).toHaveBeenCalledOnce();
  });
  it('supports save-only and refreshes without navigating; a later edit is guarded again', () => {
    let tree = renderEdit();
    button(tree, '保存草稿修订').props.onClick!();
    mocks.state = { saved: true, error: null };
    tree = renderEdit();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
    const onChange = fields(tree).props.onChange as unknown as (
      field: string,
      value: string,
    ) => void;
    onChange('materialsSummary', '未保存的新内容');
    tree = renderEdit();
    expect(text(tree)).toContain('有未保存的修改');
    expect(mocks.guard).toHaveBeenLastCalledWith(true);
    expect(button(tree, '保存草稿修订').props.disabled).toBe(false);
  });
  it('keeps a dirty form on its original revision when a different tab changes saved data', () => {
    let tree = renderEdit();
    const onChange = fields(tree).props.onChange as unknown as (
      field: string,
      value: string,
    ) => void;
    onChange('materialsSummary', '我的未保存改动');
    tree = renderEdit({
      ...editProps,
      draftRevision: 3,
      draft: { ...draft, materialsSummary: '其他页面的新修订' },
    });
    expect(text(tree)).toContain('资料已在其他页面更新');
    expect(nodes(tree).find((node) => node.props.name === 'draftRevision')?.props.value).toBe(2);
    expect(fields(tree).props.values?.['materialsSummary']).toBe('我的未保存改动');
  });
  it('never exposes an arbitrary or cross-merchant continuation destination', () => {
    const tree = renderEdit({
      ...editProps,
      continueHref: `/${'c'.repeat(32)}/knowledge/${assistantId}`,
    });
    expect(text(tree)).not.toContain('保存并继续');
  });
  it('navigates to knowledge only after a real successful create result and retains an explicit fallback link', async () => {
    const NativeFormData = globalThis.FormData;
    const form = new NativeFormData();
    for (const [key, value] of Object.entries({ displayName: '我的客服', ...draft }))
      form.set(key, value);
    vi.stubGlobal(
      'FormData',
      class {
        constructor() {
          return form;
        }
      },
    );
    let tree = renderCreate();
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ created: { assistantId, displayName: '我的客服' } }),
    );
    await (tree.props as Props).onSubmit!({ preventDefault: vi.fn(), currentTarget: {} });
    tree = renderCreate();
    renderCreate();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith(`/${merchantId}/knowledge/${assistantId}`);
    expect(text(tree)).toContain('下一步：上传与补充知识');
    expect(text(tree)).not.toContain('已发布');
  });
  it('does not navigate for a failed create and keeps editable values', async () => {
    const NativeFormData = globalThis.FormData;
    const form = new NativeFormData();
    for (const [key, value] of Object.entries({ displayName: '我的客服', ...draft }))
      form.set(key, value);
    vi.stubGlobal(
      'FormData',
      class {
        constructor() {
          return form;
        }
      },
    );
    const tree = renderCreate();
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: '暂不可用' }, { status: 503 }));
    await (tree.props as Props).onSubmit!({ preventDefault: vi.fn(), currentTarget: {} });
    expect(text(renderCreate())).toContain('暂不可用');
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
