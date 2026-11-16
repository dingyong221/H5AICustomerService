import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  authoringTaskSchema,
  draftExpandRequestSchema,
  type DraftExpandTask,
} from '@h5cs/contracts';
const state = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  effects: [] as (() => unknown)[],
  cleanups: [] as (() => void)[],
  fetch: vi.fn(),
}));
vi.mock('react', async (load) => ({
  ...(await load<typeof import('react')>()),
  useState<T>(initial: T) {
    const i = state.cursor++;
    if (!(i in state.hooks)) state.hooks[i] = initial;
    return [
      state.hooks[i],
      (next: T | ((old: T) => T)) => {
        state.hooks[i] =
          typeof next === 'function' ? (next as (old: T) => T)(state.hooks[i] as T) : next;
      },
    ];
  },
  useRef<T>(initial: T) {
    const i = state.cursor++;
    if (!(i in state.hooks)) state.hooks[i] = { current: initial };
    return state.hooks[i];
  },
  useEffect(effect: () => unknown, deps: unknown[]) {
    const i = state.cursor++,
      old = state.hooks[i] as unknown[] | undefined;
    if (!old || deps.some((value, j) => value !== old[j])) {
      state.hooks[i] = deps;
      state.effects.push(effect);
    }
  },
}));
import { usePersistentTask } from './use-persistent-task';
const key = 'h5cs:draft-expand:user:merchant:assistant:industry',
  taskId = 'a'.repeat(32),
  requestId = `authoring_${'b'.repeat(32)}`;
const task: DraftExpandTask = {
  kind: 'draft.expand',
  taskId,
  state: 'queued',
  modelOutcome: 'none',
  inputRevision: 3,
  inputFieldHash: 'c'.repeat(64),
  field: 'industry',
  canUse: false,
  canRetry: false,
  stale: false,
  createdAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
};
const input = {
  revision: 3,
  field: 'industry',
  brief: '店铺零售',
  currentText: ' 原文 ',
  consent: true,
};
let storage: Map<string, string>;
const options = {
  endpoint: '/merchant/drafts/assistant/expand-tasks',
  recoveryKey: key,
  csrf: 'private-csrf',
  enabled: true,
  revision: 3,
  parseCreate: (value: unknown) => draftExpandRequestSchema.parse(value),
  parseTask: (value: unknown) => {
    const t = authoringTaskSchema.parse(value);
    if (t.kind !== 'draft.expand') throw Error('wrong kind');
    return t;
  },
};
function render(overrides: Partial<typeof options> = {}) {
  state.cursor = 0;
  // Deterministic hook runner with mocked React; no rendered component owns this cursor.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const result = usePersistentTask({ ...options, ...overrides });
  for (const effect of state.effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') state.cleanups.push(cleanup as () => void);
  }
  return result;
}
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
function saved(value: unknown = { requestId, taskId }) {
  storage.set(key, JSON.stringify(value));
}
function unmount() {
  for (const cleanup of state.cleanups.splice(0)) cleanup();
  state.hooks = [];
  state.effects = [];
}
beforeEach(() => {
  state.hooks = [];
  state.effects = [];
  state.cleanups = [];
  state.cursor = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
  storage = new Map();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  vi.stubGlobal('fetch', state.fetch);
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('shared persistent authoring lifecycle (mock HTTP/storage)', () => {
  it('persists exact original input before POST, then strips payload and credentials from recovery record', async () => {
    render();
    state.fetch.mockImplementation(async (_url, init) => {
      const reference = JSON.parse(storage.get(key)!);
      expect(reference.submission.body.currentText).toBe(' 原文 ');
      expect(storage.get(key)).not.toContain('private-csrf');
      expect(init.headers['x-h5cs-csrf']).toBe('private-csrf');
      return Response.json(task);
    });
    const flow = render();
    await flow.write('create', input);
    expect(render().task).toEqual(task);
    expect(JSON.parse(storage.get(key)!)).toEqual({
      requestId: expect.stringMatching(/^authoring_[a-f0-9]{32}$/),
      taskId,
    });
    expect(state.fetch).toHaveBeenCalledOnce();
  });
  it('unknown POST is recovered by original request after remount, never resent or silently closed', async () => {
    render();
    state.fetch.mockRejectedValueOnce(new TypeError('network'));
    await render().write('create', input);
    const original = JSON.parse(storage.get(key)!);
    expect(render().bound).toBe(true);
    expect(render().canClose).toBe(false);
    await render().write('create', input);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    unmount();
    state.fetch.mockResolvedValueOnce(Response.json(task));
    render();
    await flush();
    expect(state.fetch).toHaveBeenLastCalledWith(
      `${options.endpoint}?requestId=${original.requestId}`,
      expect.not.objectContaining({ method: 'POST' }),
    );
    expect(render().task?.taskId).toBe(taskId);
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });
  it('only trusted missing GET allows explicit resubmission with exactly the same ID/body', async () => {
    saved({ requestId, submission: { body: { ...input, requestId } } });
    state.fetch.mockResolvedValueOnce(Response.json(null));
    render();
    await flush();
    expect(render().canResume).toBe(true);
    state.fetch.mockResolvedValueOnce(Response.json(task));
    await render().write('resume');
    expect(JSON.parse(state.fetch.mock.calls[1]![1].body)).toEqual({ ...input, requestId });
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });
  it('storage failure blocks dispatch and leaves input unsent', async () => {
    render();
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw Error('quota');
    });
    await render().write('create', input);
    expect(state.fetch).not.toHaveBeenCalled();
    expect(render().error).toContain('本次未发送');
  });
  it('double submission dispatches once while first response is pending', async () => {
    render();
    let resolve!: (response: Response) => void;
    state.fetch.mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const flow = render();
    const first = flow.write('create', input);
    await flow.write('create', input);
    expect(state.fetch).toHaveBeenCalledOnce();
    resolve(Response.json(task));
    await first;
  });
  it('ignores a late pre-cancel GET rather than restoring queued state', async () => {
    saved();
    state.fetch.mockResolvedValueOnce(Response.json(task));
    render();
    await flush();
    let resolve!: (response: Response) => void;
    state.fetch.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const oldRead = render().refresh();
    state.fetch.mockResolvedValueOnce(Response.json({ ...task, state: 'cancelled' }));
    await render().write('cancel');
    resolve(Response.json(task));
    await oldRead;
    expect(render().task?.state).toBe('cancelled');
  });
  it('late POST after unmount leaves original durable reference for a new mount', async () => {
    render();
    let resolve!: (response: Response) => void;
    state.fetch.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const pending = render().write('create', input);
    const before = storage.get(key);
    unmount();
    resolve(Response.json(task));
    await pending;
    expect(storage.get(key)).toBe(before);
    state.fetch.mockResolvedValueOnce(Response.json(task));
    render();
    await flush();
    expect(render().task?.taskId).toBe(taskId);
  });
  it.each(['unknown', 'dispatched'] as const)(
    'cannot retry/close failed %s even if flags incorrectly suggest retry',
    async (modelOutcome) => {
      saved();
      state.fetch.mockResolvedValueOnce(
        Response.json({ ...task, state: 'failed', modelOutcome, canRetry: true }),
      );
      render();
      await flush();
      const flow = render();
      expect(flow.canRetry).toBe(false);
      expect(flow.canClose).toBe(false);
      await flow.write('retry');
      expect(flow.close()).toBe(false);
      expect(state.fetch).toHaveBeenCalledOnce();
    },
  );
  it('safe retry uses a new explicit ID and retry endpoint, then strips submission', async () => {
    saved();
    state.fetch.mockResolvedValueOnce(
      Response.json({ ...task, state: 'failed', modelOutcome: 'failed', canRetry: true }),
    );
    render();
    await flush();
    expect(render().canRetry).toBe(true);
    state.fetch.mockResolvedValueOnce(Response.json({ ...task, taskId: 'd'.repeat(32) }));
    await render().write('retry');
    const call = state.fetch.mock.calls[1]!;
    expect(call[0]).toBe(`${options.endpoint}/${taskId}/retry`);
    expect(JSON.parse(call[1].body)).toEqual({
      requestId: expect.stringMatching(/^authoring_[a-f0-9]{32}$/),
    });
    expect(JSON.parse(call[1].body).requestId).not.toBe(requestId);
  });
  it.each(['failed', 'cancelled'] as const)(
    'verified %s+succeeded with no candidate can close explicitly, without server deletion',
    async (terminal) => {
      saved();
      state.fetch.mockResolvedValueOnce(
        Response.json({ ...task, state: terminal, modelOutcome: 'succeeded' }),
      );
      render();
      await flush();
      expect(render().canClose).toBe(true);
      expect(render().close()).toBe(true);
      expect(storage.has(key)).toBe(false);
      expect(state.fetch).toHaveBeenCalledOnce();
    },
  );
  it('feature off still restores and cancels an existing task, but cannot create/retry/resume', async () => {
    saved();
    state.fetch.mockResolvedValueOnce(Response.json(task));
    render({ enabled: false });
    await flush();
    const flow = render({ enabled: false });
    expect(flow.bound).toBe(true);
    await flow.write('create', input);
    await flow.write('retry');
    await flow.write('resume');
    expect(state.fetch).toHaveBeenCalledOnce();
    state.fetch.mockResolvedValueOnce(Response.json({ ...task, state: 'cancelled' }));
    await flow.write('cancel');
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });
  it('different authenticated scope never reads the previous user record', () => {
    saved();
    render({ recoveryKey: 'h5cs:draft-expand:other:merchant:assistant:industry' });
    expect(
      render({ recoveryKey: 'h5cs:draft-expand:other:merchant:assistant:industry' }).bound,
    ).toBe(false);
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('invalid recovery input fails closed instead of silently falling back', () => {
    saved({ requestId, submission: { body: { ...input, requestId, userId: 'attacker' } } });
    render();
    expect(render().loaded).toBe(false);
    expect(render().error).toContain('无法读取');
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it('revision change, stale snapshot, or failed GET blocks retry and local close when unverified', async () => {
    saved();
    state.fetch.mockResolvedValueOnce(
      Response.json({ ...task, state: 'failed', modelOutcome: 'failed', canRetry: true }),
    );
    render();
    await flush();
    expect(render({ revision: 4 }).canRetry).toBe(false);
    state.fetch.mockRejectedValueOnce(new TypeError('offline'));
    await render().refresh();
    expect(render().verified).toBe(false);
    expect(render().canRetry).toBe(false);
    expect(render().canClose).toBe(false);
  });
  it('paused POST retains the same durable request and blocks new keys until a later original GET reports runnable', async () => {
    render();
    state.fetch.mockResolvedValueOnce(
      Response.json(
        { code: 'UNAVAILABLE', error: '暂停' },
        { status: 503, headers: { 'X-H5CS-Execution-State': 'paused' } },
      ),
    );
    await render().write('create', input);
    const original = JSON.parse(storage.get(key)!);
    expect(render().executionState).toBe('paused');
    expect(render().bound).toBe(true);
    await render().write('create', input);
    expect(state.fetch).toHaveBeenCalledOnce();
    state.fetch.mockResolvedValueOnce(
      Response.json(null, { headers: { 'X-H5CS-Execution-State': 'paused' } }),
    );
    await render().refresh();
    expect(render().canResume).toBe(false);
    await render().write('resume');
    expect(state.fetch).toHaveBeenCalledTimes(2);
    state.fetch.mockResolvedValueOnce(
      Response.json(null, { headers: { 'X-H5CS-Execution-State': 'runnable' } }),
    );
    await render().refresh();
    expect(render().canResume).toBe(true);
    state.fetch.mockResolvedValueOnce(Response.json(task));
    await render().write('resume');
    expect(JSON.parse(state.fetch.mock.calls[3]![1].body)).toEqual(original.submission.body);
    expect(storage.get(key)).not.toContain('private-csrf');
  });
  it('terminal successful task remains usable and closeable even when a pause header arrives', async () => {
    saved();
    const onResult = vi.fn();
    state.fetch.mockResolvedValueOnce(
      Response.json(
        {
          ...task,
          state: 'completed',
          modelOutcome: 'succeeded',
          canUse: true,
          result: { options: ['零售店铺', '商品销售门店'], reminders: [] },
        },
        { headers: { 'X-H5CS-Execution-State': 'paused' } },
      ),
    );
    render({ ...options, onResult } as typeof options);
    await flush();
    expect(render().task?.state).toBe('completed');
    expect(render().verified).toBe(true);
    expect(render().canClose).toBe(true);
    expect(onResult).toHaveBeenCalledOnce();
  });
});
