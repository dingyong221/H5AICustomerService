import React, { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationState } from './conversation-model';
import type { OnlinePublicAssistantSnapshot } from './public-api-client';

const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  reload: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useState<T>(initial: T) {
    const index = mocks.cursor++;
    if (!(index in mocks.hooks)) mocks.hooks[index] = initial;
    return [
      mocks.hooks[index],
      (next: T | ((value: T) => T)) => {
        mocks.hooks[index] =
          typeof next === 'function' ? (next as (value: T) => T)(mocks.hooks[index] as T) : next;
      },
    ];
  },
  useRef<T>(initial: T) {
    const index = mocks.cursor++;
    if (!(index in mocks.hooks)) mocks.hooks[index] = { current: initial };
    return mocks.hooks[index];
  },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
}));
vi.mock('./session-reference', () => ({
  clearBrowserSessionReference: mocks.clear,
  readBrowserSessionReference: vi.fn(),
  saveBrowserSessionReference: vi.fn(),
}));
import { OnlineCustomerService } from './online-customer-service';
import { HumanContactNotice } from './human-contact-notice';

type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean; name?: string };
const snapshot: OnlinePublicAssistantSnapshot = {
  aiDisclosure: true,
  assistantDisplayName: '测试客服',
  availability: 'online',
  businessScope: '测试商品咨询',
  merchantDisplayName: '测试商家',
  publicAssistantId: 'test-customer',
  releaseRef: 'release_latest_1234',
  welcomeMessage: '欢迎咨询',
  humanContact: '微信 test_service',
};
const session = {
  createdAt: '2026-10-24T00:00:00.000Z',
  releaseRef: 'release_old_1234',
  sessionHandle: `s_${'a'.repeat(32)}`,
  state: 'active' as const,
};
function pending(code?: string): ConversationState {
  return {
    session,
    messages: [],
    pending: {
      clientMessageId: 'message_1234567890',
      sessionRequestId: `session_request_${'b'.repeat(32)}`,
      content: '这个商品多少钱？',
      phase: 'failed',
      retryable: code !== 'RELEASE_WITHDRAWN',
      errorMessage: '暂未收到回复',
      errorCode: code,
    },
  };
}
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Props>(node) ? [node, ...nodes(node.props.children)] : [];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<Props>(node)) return text(node.props.children);
  return node == null || typeof node === 'boolean' ? '' : String(node);
}
function render() {
  mocks.cursor = 0;
  return OnlineCustomerService({
    apiBaseUrl: '/api/v1/public',
    publicSlug: snapshot.publicAssistantId,
    snapshot,
  });
}
function button(tree: ReactNode, label: string) {
  const found = nodes(tree).find((node) => node.type === 'button' && text(node) === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
describe('consumer recovery controls', () => {
  beforeEach(() => {
    mocks.hooks = [];
    mocks.cursor = 0;
    vi.clearAllMocks();
    vi.stubGlobal('React', React);
    vi.stubGlobal('window', { location: { reload: mocks.reload }, sessionStorage: {} });
    render();
    mocks.hooks[4] = 'ready';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retries the exact original request and keeps the original question and session IDs', () => {
    const original = pending();
    mocks.hooks[0] = original;
    button(render(), '重试回复').props.onClick!();
    expect((mocks.hooks[0] as ConversationState).pending).toMatchObject({
      phase: 'sending',
      content: original.pending!.content,
      clientMessageId: original.pending!.clientMessageId,
      sessionRequestId: original.pending!.sessionRequestId,
    });
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('continues without replaying a failed question and retains its text in this page', () => {
    mocks.hooks[0] = pending();
    button(render(), '继续提问').props.onClick!();
    const tree = render();
    expect((mocks.hooks[0] as ConversationState).pending).toBeUndefined();
    expect(text(tree)).toContain('这个商品多少钱？');
    expect(text(tree)).toContain('不会自动重发');
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('provides an explicit connection refresh and never refreshes a failed item automatically', () => {
    mocks.hooks[0] = pending();
    const tree = render();
    expect(mocks.reload).not.toHaveBeenCalled();
    button(tree, '刷新客服状态').props.onClick!();
    expect(mocks.reload).toHaveBeenCalledOnce();
  });

  it('provides a check-only exit for unknown results without offering retry or implying completion', () => {
    mocks.hooks[0] = pending('MODEL_RESULT_UNKNOWN');
    const tree = render();
    expect(text(tree)).not.toContain('重试回复');
    expect(text(tree)).not.toContain('重试会继续确认');
    expect(text(tree)).toContain('刷新只核对已有咨询');
    expect(text(tree)).toContain('避免重复提交');
    button(tree, '保留问题，继续输入').props.onClick!();
    expect((mocks.hooks[0] as ConversationState).pending).toBeUndefined();
    expect(text(render())).toContain('这个商品多少钱？');
    expect(mocks.reload).not.toHaveBeenCalled();
  });

  it('routes withdrawal only through an explicit latest-page refresh, without new message or session', () => {
    mocks.hooks[0] = pending('RELEASE_WITHDRAWN');
    const tree = render();
    expect(text(tree)).toContain('商家已撤回');
    expect(text(tree)).not.toContain('重试回复');
    expect(text(tree)).not.toContain('继续提问');
    const contact = nodes(tree).find((node) => node.type === HumanContactNotice);
    expect((contact?.props as { instructions?: string }).instructions).toBeUndefined();
    button(tree, '查看最新客服').props.onClick!();
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith('test-customer');
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect((mocks.hooks[0] as ConversationState).session).toBe(session);
  });

  it('gives the same safe withdrawal exit while restoring an old consultation', () => {
    mocks.hooks[4] = 'failed';
    mocks.hooks[7] = 'RELEASE_WITHDRAWN';
    const tree = render();
    expect(text(tree)).toContain('查看最新客服');
    expect(text(tree)).not.toContain('重试恢复上次咨询');
  });

  it('explains a pinned earlier version without replacing its snapshot or session', () => {
    mocks.hooks[0] = { session, messages: [] };
    mocks.hooks[1] = { ...snapshot, releaseRef: session.releaseRef };
    const tree = render();
    expect(text(tree)).toContain('商家资料已有新版');
    expect(text(tree)).toContain('本次咨询仍使用开始时的资料');
    expect((mocks.hooks[0] as ConversationState).session?.releaseRef).toBe('release_old_1234');
  });

  it('shows long-wait guidance rather than implying token streaming or posting again', () => {
    const state = pending();
    mocks.hooks[0] = { ...state, pending: { ...state.pending!, phase: 'waiting' } };
    mocks.hooks[9] = { id: state.pending!.clientMessageId, seconds: 46 };
    expect(text(render())).toContain('请勿重复发送');
    expect(text(render())).not.toContain('正在逐字');
    button(render(), '刷新并恢复咨询').props.onClick!();
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it('paused consultation retains typed input, original session and human contact with a check-only refresh', () => {
    mocks.hooks[0] = { session, messages: [] };
    mocks.hooks[2] = '尚未发送的输入';
    mocks.hooks[14] = 'paused';
    const tree = render();
    expect(text(tree)).toContain('AI 回复暂时暂停');
    expect(text(tree)).toContain('不会自动重发新问题');
    expect((mocks.hooks[0] as ConversationState).session).toBe(session);
    expect(mocks.hooks[2]).toBe('尚未发送的输入');
    const contact = nodes(tree).find((node) => node.type === HumanContactNotice);
    expect((contact?.props as { instructions?: string }).instructions).toBe('微信 test_service');
    button(tree, '刷新并核对原咨询').props.onClick!();
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it('retry after an accepted-turn connection failure preserves the original result and event URLs', () => {
    const original = pending();
    const turn = {
      eventsUrl: '/api/v1/public/original/events',
      resultUrl: '/api/v1/public/original',
      traceId: 'trace_original',
      turnId: 'turn_original',
      state: 'accepted' as const,
    };
    mocks.hooks[0] = { ...original, pending: { ...original.pending!, turn } };
    button(render(), '重试回复').props.onClick!();
    expect((mocks.hooks[0] as ConversationState).pending?.turn).toBe(turn);
    expect((mocks.hooks[0] as ConversationState).pending?.clientMessageId).toBe(
      original.pending?.clientMessageId,
    );
  });
});
