import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationState } from './conversation-model';
const mocks = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  cleanups: [] as (() => void)[],
  clear: vi.fn(),
  client: {
    resumeSession: vi.fn(),
    loadHistory: vi.fn(),
    readTurn: vi.fn(),
    sendMessage: vi.fn(),
    createSession: vi.fn(),
  },
}));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useState<T>(initial: T) {
    const i = mocks.cursor++;
    if (!(i in mocks.hooks)) mocks.hooks[i] = initial;
    return [
      mocks.hooks[i],
      (next: T) => {
        mocks.hooks[i] = next;
      },
    ];
  },
  useRef<T>(initial: T) {
    const i = mocks.cursor++;
    if (!(i in mocks.hooks)) mocks.hooks[i] = { current: initial };
    return mocks.hooks[i];
  },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: (effect: () => unknown) => {
    mocks.effects.push(effect);
  },
}));
vi.mock('./session-reference', () => ({
  clearBrowserSessionReference: mocks.clear,
  readBrowserSessionReference: () => `session_request_${'b'.repeat(32)}`,
  saveBrowserSessionReference: vi.fn(),
}));
vi.mock('./public-api-client', async (load) => ({
  ...(await load<typeof import('./public-api-client')>()),
  createPublicAssistantApiClient: () => mocks.client,
}));
import { OnlineCustomerService } from './online-customer-service';
const snapshot = {
  aiDisclosure: true as const,
  assistantDisplayName: '测试客服',
  availability: 'online' as const,
  businessScope: '仅测试咨询',
  merchantDisplayName: '测试商家',
  publicAssistantId: 'test-shop',
  releaseRef: 'release_original_1234',
  welcomeMessage: '欢迎咨询',
};
const session = {
  sessionHandle: `s_${'a'.repeat(32)}`,
  releaseRef: snapshot.releaseRef,
  state: 'active' as const,
  createdAt: '2026-11-17T00:00:00Z',
};
const active = {
  turnId: 'turn_original_12345',
  clientMessageId: 'message_original_12345',
  content: '刷新前的问题',
};
const visitor = {
  ...active,
  turnId: undefined,
  messageId: 'visitor_original_12345',
  role: 'visitor',
  createdAt: session.createdAt,
  sequence: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.hooks = [];
  mocks.cursor = 0;
  mocks.effects = [];
  mocks.cleanups = [];
  vi.stubGlobal('window', { location: { origin: 'https://h5.example.test' } });
  mocks.client.resumeSession.mockResolvedValue(session);
  mocks.client.loadHistory.mockResolvedValue({
    session,
    snapshot,
    messages: [visitor],
    activeTurn: active,
    hasEarlierMessages: false,
  });
});
afterEach(() => {
  for (const cleanup of mocks.cleanups) cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  OnlineCustomerService({
    apiBaseUrl: '/api/v1/public',
    publicSlug: snapshot.publicAssistantId,
    snapshot,
  });
  for (const effect of mocks.effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') mocks.cleanups.push(cleanup as () => void);
  }
}
describe('consultation reload restoration (mock authenticated client)', () => {
  it.each(['accepted', 'completed'] as const)(
    'restores %s by original result GET, without repeating the message POST',
    async (state) => {
      mocks.client.readTurn.mockResolvedValue({
        sessionHandle: session.sessionHandle,
        turnId: active.turnId,
        traceId: 'trace_original_1234',
        state,
        messages: [visitor],
      });
      mount();
      await vi.waitFor(() => expect(mocks.hooks[4]).toBe('ready'));
      expect(mocks.client.readTurn).toHaveBeenCalledExactlyOnceWith({
        clientMessageId: active.clientMessageId,
        resultUrl: `/api/v1/public/sessions/${session.sessionHandle}/turns/${active.turnId}`,
        sessionHandle: session.sessionHandle,
        turnId: active.turnId,
        signal: expect.any(AbortSignal),
      });
      expect(mocks.client.sendMessage).not.toHaveBeenCalled();
      expect(mocks.client.createSession).not.toHaveBeenCalled();
      const conversation = mocks.hooks[0] as ConversationState;
      expect(conversation.session).toBe(session);
      if (state === 'completed') expect(conversation.pending).toBeUndefined();
      else expect(conversation.pending?.turn?.resultUrl).toContain(active.turnId);
      expect(mocks.clear).not.toHaveBeenCalled();
    },
  );
  it('unreadable original result retains the browser session reference and offers restoration retry without POST', async () => {
    mocks.client.readTurn.mockRejectedValue(new TypeError('offline'));
    mount();
    await vi.waitFor(() => expect(mocks.hooks[4]).toBe('failed'));
    expect(mocks.client.sendMessage).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
});
