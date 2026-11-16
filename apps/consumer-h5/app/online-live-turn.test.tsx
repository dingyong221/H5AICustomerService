import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationState } from './conversation-model';

const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  effectCursor: 0,
  slots: [] as { deps: unknown[]; cleanup?: () => void }[],
  effects: [] as { index: number; effect: () => unknown }[],
  fetch: vi.fn(),
  reload: vi.fn(),
  save: vi.fn(),
  clear: vi.fn(),
}));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useState<T>(initial: T) {
    const i = mocks.cursor++;
    if (!(i in mocks.hooks)) mocks.hooks[i] = initial;
    return [
      mocks.hooks[i],
      (next: T | ((previous: T) => T)) => {
        mocks.hooks[i] =
          typeof next === 'function' ? (next as (previous: T) => T)(mocks.hooks[i] as T) : next;
      },
    ];
  },
  useRef<T>(initial: T) {
    const i = mocks.cursor++;
    if (!(i in mocks.hooks)) mocks.hooks[i] = { current: initial };
    return mocks.hooks[i];
  },
  useMemo: (factory: () => unknown) => factory(),
  useEffect(effect: () => unknown, deps: unknown[]) {
    const index = mocks.effectCursor++;
    const old = mocks.slots[index];
    if (!old || deps.some((value, i) => value !== old.deps[i])) {
      old?.cleanup?.();
      mocks.slots[index] = { deps };
      mocks.effects.push({ index, effect });
    }
  },
}));
vi.mock('./session-reference', () => ({
  readBrowserSessionReference: () => null,
  saveBrowserSessionReference: mocks.save,
  clearBrowserSessionReference: mocks.clear,
}));
import { OnlineCustomerService } from './online-customer-service';

const origin = 'https://h5.example.test';
const snapshot = {
  aiDisclosure: true as const,
  assistantDisplayName: '测试客服',
  availability: 'online' as const,
  businessScope: '原已发布事实',
  merchantDisplayName: '测试商家',
  publicAssistantId: 'test-shop',
  releaseRef: 'release_original_12345',
  welcomeMessage: '欢迎咨询',
  humanContact: '电话：4001234567',
};
const session = {
  sessionHandle: `s_${'a'.repeat(32)}`,
  releaseRef: snapshot.releaseRef,
  createdAt: '2026-11-17T00:00:00Z',
  state: 'active',
};
const turnId = 'turn_original_12345';
const resultUrl = `${origin}/api/v1/public/sessions/${session.sessionHandle}/turns/${turnId}`;
const accepted = {
  resultUrl,
  eventsUrl: `${resultUrl}/events`,
  turnId,
  traceId: 'trace_original_12345',
  state: 'accepted',
};
type Props = {
  children?: ReactNode;
  id?: string;
  disabled?: boolean;
  onClick?: () => unknown;
  onSubmit?: (event: { preventDefault: () => void }) => void;
  onChange?: (event: { target: { value: string } }) => void;
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
let clientMessageId: string;
let source: ReadableStreamDefaultController<Uint8Array>;
let cancel: () => void;
let resultStates: ('paused' | 'draining' | 'runnable' | 'completed')[];
let deferredResult: Promise<Response> | null;
const envelope = (data: unknown, status = 200, execution?: string) =>
  Response.json(
    { data, request_id: 'request_original_12345' },
    { status, headers: execution ? { 'X-H5CS-Execution-State': execution } : {} },
  );
const visitor = () => ({
  messageId: 'message_original_visitor',
  clientMessageId,
  content: '原咨询问题',
  createdAt: session.createdAt,
  sequence: 1,
  role: 'visitor',
});
const result = (state: 'processing' | 'completed' = 'processing') => ({
  sessionHandle: session.sessionHandle,
  turnId,
  traceId: accepted.traceId,
  state,
  messages: [visitor()],
});
const frame = () =>
  new TextEncoder().encode(`event: processing\ndata: ${JSON.stringify(result())}\n\n`);
function render() {
  mocks.cursor = 0;
  mocks.effectCursor = 0;
  const tree = OnlineCustomerService({
    apiBaseUrl: '/api/v1/public',
    publicSlug: snapshot.publicAssistantId,
    snapshot,
  });
  for (const { index, effect } of mocks.effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') mocks.slots[index]!.cleanup = cleanup as () => void;
  }
  return tree;
}
async function settle() {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 25; j++) await Promise.resolve();
    render();
  }
}
function unmount() {
  for (const slot of mocks.slots) slot.cleanup?.();
  mocks.slots = [];
  mocks.effects = [];
}
async function send() {
  render();
  await settle();
  nodes(render()).find((node) => node.props.id === 'message-input')!.props.onChange!({
    target: { value: '原咨询问题' },
  });
  nodes(render()).find((node) => node.type === 'form')!.props.onSubmit!({ preventDefault() {} });
  render();
  await settle();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.hooks = [];
  mocks.cursor = 0;
  mocks.effectCursor = 0;
  mocks.slots = [];
  mocks.effects = [];
  clientMessageId = '';
  cancel = vi.fn();
  resultStates = ['paused', 'draining', 'runnable', 'completed'];
  deferredResult = null;
  vi.stubGlobal('window', {
    location: { origin, reload: mocks.reload },
    confirm: () => true,
    setInterval,
    clearInterval,
  });
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockImplementation(async (url: string | URL, options: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/messages')) {
      clientMessageId = (JSON.parse(String(options.body)) as { clientMessageId: string })
        .clientMessageId;
      return envelope(accepted, 202, 'draining');
    }
    if (path.endsWith('/events'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(frame());
          },
          cancel,
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    if (path === resultUrl) {
      if (deferredResult) return deferredResult;
      const state = resultStates.shift() ?? 'completed';
      return envelope(
        result(state === 'completed' ? 'completed' : 'processing'),
        200,
        state === 'completed' ? 'paused' : state,
      );
    }
    if (path.endsWith('/end'))
      return envelope({ sessionHandle: session.sessionHandle, state: 'ended' });
    if (path.endsWith('/sessions')) return envelope(session, 201);
    throw Error(`Unexpected synthetic endpoint ${path}`);
  });
});
afterEach(async () => {
  unmount();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('consumer component with real public transport and an SSE that never closes', () => {
  it('sees later pause/drain/resume without 90-second stream closure, preserves original input/keys and releases terminal work', async () => {
    await send();
    expect(clientMessageId).toMatch(/^message_[a-f0-9]{32}$/u);
    const original = (mocks.hooks[0] as ConversationState).pending!;
    expect(original.turn?.resultUrl).toBe(resultUrl);
    expect(text(render())).toContain('AI 回复暂时暂停'); // send draining survives missing stream header
    await vi.advanceTimersByTimeAsync(400);
    source.enqueue(new TextEncoder().encode(': keepalive\n\n'));
    await vi.advanceTimersByTimeAsync(400);
    source.enqueue(frame());
    await vi.advanceTimersByTimeAsync(700);
    await settle();
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.hooks[14]).toBe('paused');
    expect(text(render())).toContain('原咨询问题');
    expect(text(render())).toContain('原已发布事实');
    expect((mocks.hooks[0] as ConversationState).pending).toMatchObject({
      clientMessageId: original.clientMessageId,
      sessionRequestId: original.sessionRequestId,
      content: original.content,
      turn: original.turn,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(mocks.hooks[14]).toBe('draining');
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(mocks.hooks[14]).toBe('runnable');
    expect(text(render())).not.toContain('AI 回复暂时暂停');
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect((mocks.hooks[0] as ConversationState).pending).toBeUndefined();
    expect(mocks.hooks[14]).toBeNull();
    const posts = mocks.fetch.mock.calls.filter(([, options]) => options.method === 'POST');
    expect(posts).toHaveLength(2); // original session and original message, no retries
    expect(posts[1]![1].headers['Idempotency-Key']).toBe(original.clientMessageId);
    const reads = mocks.fetch.mock.calls.filter(([url]) => String(url) === resultUrl);
    expect(reads).toHaveLength(4);
    for (const [, options] of reads)
      expect(options).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect(vi.getTimerCount()).toBe(0);
    nodes(render()).find((node) => node.props.id === 'message-input')!.props.onChange!({
      target: { value: '下一条未发送输入' },
    });
    const before = mocks.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90000);
    await settle();
    expect(mocks.fetch).toHaveBeenCalledTimes(before);
    expect(mocks.hooks[2]).toBe('下一条未发送输入');
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it('unmount aborts a hanging original GET; its late terminal response cannot overwrite input, state or session', async () => {
    let resolve!: (response: Response) => void;
    deferredResult = new Promise<Response>((done) => {
      resolve = done;
    });
    await send();
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url) === resultUrl)).toHaveLength(1);
    const before = JSON.stringify([mocks.hooks[0], mocks.hooks[2], mocks.hooks[14]]);
    unmount();
    resolve(envelope(result('completed'), 200, 'paused'));
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(JSON.stringify([mocks.hooks[0], mocks.hooks[2], mocks.hooks[14]])).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it('a late timed-out old GET cannot revive the old question after an explicit new consultation action', async () => {
    let resolve!: (response: Response) => void;
    deferredResult = new Promise<Response>((done) => {
      resolve = done;
    });
    await send();
    await vi.advanceTimersByTimeAsync(12000);
    await settle();
    expect((mocks.hooks[0] as ConversationState).pending?.phase).toBe('failed');
    nodes(render()).find((node) => node.type === 'button' && text(node) === '继续提问')!.props
      .onClick!();
    render();
    nodes(render()).find((node) => node.props.id === 'message-input')!.props.onChange!({
      target: { value: '新咨询前保留的输入' },
    });
    render();
    nodes(render()).find((node) => node.type === 'button' && text(node) === '新建咨询')!.props
      .onClick!();
    await settle();
    expect(mocks.reload).toHaveBeenCalledOnce();
    const before = JSON.stringify([mocks.hooks[0], mocks.hooks[2], mocks.hooks[14]]);
    resolve(envelope(result('completed'), 200, 'paused'));
    await settle();
    expect(JSON.stringify([mocks.hooks[0], mocks.hooks[2], mocks.hooks[14]])).toBe(before);
    expect(mocks.hooks[2]).toBe('新咨询前保留的输入');
    expect(mocks.clear).toHaveBeenCalledOnce(); // only the user's explicit end-session action
    expect(mocks.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(
      3,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
