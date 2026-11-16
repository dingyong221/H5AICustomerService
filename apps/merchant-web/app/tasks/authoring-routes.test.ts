import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  write: vi.fn(),
  list: vi.fn(),
  config: vi.fn(),
  draft: vi.fn(),
  preview: vi.fn(),
  get: vi.fn(),
  find: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  AccessError: class extends Error {},
}));
vi.mock('../account/merchant-actions', () => ({
  currentMerchant: mocks.current,
  currentMerchantForWrite: mocks.write,
}));
vi.mock('@h5cs/database', async () => ({
  AuthoringTaskError: (await import('@h5cs/domain')).AuthoringTaskError,
  KnowledgeMaterialAccessError: mocks.AccessError,
  loadDatabaseConfig: mocks.config,
  MySqlKnowledgeMaterialRepository: class {
    list = mocks.list;
  },
  MySqlAuthoringTaskRepository: class {
    enqueueDraftExpand = mocks.draft;
    enqueuePreviewReply = mocks.preview;
    get = mocks.get;
    findByRequest = mocks.find;
    cancel = mocks.cancel;
    retry = mocks.retry;
  },
}));
import { AuthoringTaskError } from '@h5cs/domain';
import {
  GET as draftFind,
  POST as draftCreate,
} from '../[merchantId]/drafts/[assistantId]/expand-tasks/route';
import { GET as draftGet } from '../[merchantId]/drafts/[assistantId]/expand-tasks/[taskId]/route';
import { POST as draftCancel } from '../[merchantId]/drafts/[assistantId]/expand-tasks/[taskId]/cancel/route';
import { POST as draftRetry } from '../[merchantId]/drafts/[assistantId]/expand-tasks/[taskId]/retry/route';
import {
  GET as previewFind,
  POST as previewCreate,
} from '../[merchantId]/preview/[assistantId]/reply-tasks/route';
import { GET as previewGet } from '../[merchantId]/preview/[assistantId]/reply-tasks/[taskId]/route';
import { POST as previewCancel } from '../[merchantId]/preview/[assistantId]/reply-tasks/[taskId]/cancel/route';
import { POST as previewRetry } from '../[merchantId]/preview/[assistantId]/reply-tasks/[taskId]/retry/route';
const merchantId = 'a'.repeat(32),
  assistantId = 'b'.repeat(32),
  taskId = 'c'.repeat(32),
  userId = 'd'.repeat(32),
  requestId = `authoring_${'e'.repeat(32)}`;
const scope = { merchantId, assistantId, taskId },
  params = { params: Promise.resolve(scope) },
  authorized = { merchantId, assistantId, userId };
const origin = 'https://merchant.test',
  url = `${origin}/${merchantId}/tasks`;
const base = {
  taskId,
  state: 'queued',
  inputRevision: 3,
  createdAt: '2026-11-17T00:00:00Z',
  updatedAt: '2026-11-17T00:00:00Z',
  modelOutcome: 'none',
  stale: false,
  canRetry: false,
};
const draftTask = {
  ...base,
  kind: 'draft.expand',
  field: 'industry',
  inputFieldHash: 'f'.repeat(64),
  canUse: false,
};
const previewTask = {
  ...base,
  kind: 'preview.reply',
  inputFactsHash: 'f'.repeat(64),
  canJudge: false,
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'x-h5cs-csrf': 'synthetic-csrf',
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe.each([
  {
    kind: 'draft.expand',
    task: draftTask,
    other: previewTask,
    create: draftCreate,
    get: draftGet,
    find: draftFind,
    cancel: draftCancel,
    retry: draftRetry,
    enqueue: mocks.draft,
    body: {
      requestId,
      revision: 3,
      field: 'industry',
      brief: '店铺零售',
      currentText: ' 原始文字 ',
      consent: true,
    },
  },
  {
    kind: 'preview.reply',
    task: previewTask,
    other: draftTask,
    create: previewCreate,
    get: previewGet,
    find: previewFind,
    cancel: previewCancel,
    retry: previewRetry,
    enqueue: mocks.preview,
    body: { requestId, revision: 3, question: '服务范围？' },
  },
])('$kind HTTP (real route/schema, mocked sessions/persistence)', (row) => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', origin);
    mocks.config.mockReturnValue({ configured: true, config: {} });
    mocks.current.mockResolvedValue({ merchantUserId: userId });
    mocks.write.mockResolvedValue({ merchantUserId: userId });
    mocks.list.mockResolvedValue([]);
    for (const fn of [mocks.draft, mocks.preview, mocks.get, mocks.find, mocks.cancel, mocks.retry])
      fn.mockResolvedValue(row.task);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('GET uses real read session scope without Origin or CSRF, and never dispatches', async () => {
    expect((await row.get(new Request(url), params)).status).toBe(200);
    const response = await row.find(new Request(`${url}?requestId=${requestId}`), params);
    expect(await response.json()).toEqual(row.task);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.get).toHaveBeenCalledWith(authorized, taskId);
    expect(mocks.find).toHaveBeenCalledWith(authorized, row.kind, requestId);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(row.enqueue).not.toHaveBeenCalled();
  });
  it('conceals absent sessions and foreign scope identically', async () => {
    mocks.current.mockResolvedValueOnce(null);
    const absent = await row.get(new Request(url), params);
    mocks.get.mockRejectedValueOnce(new AuthoringTaskError('NOT_FOUND'));
    const foreign = await row.get(new Request(url), params);
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual(await foreign.json());
  });
  it('find null preserves missing original request and invalid query never enqueues', async () => {
    mocks.find.mockResolvedValue(null);
    expect(
      await (await row.find(new Request(`${url}?requestId=${requestId}`), params)).json(),
    ).toBeNull();
    expect((await row.find(new Request(`${url}?requestId=invalid`), params)).status).toBe(400);
    expect(row.enqueue).not.toHaveBeenCalled();
  });
  it('checks Origin/CSRF and editable assistant before consuming the body', async () => {
    for (const handler of [row.create, row.cancel, row.retry]) {
      const request = post({}, { Origin: 'https://wrong.test' });
      const read = vi.spyOn(request.body!, 'getReader');
      expect((await handler(request, params)).status).toBe(404);
      expect(read).not.toHaveBeenCalled();
    }
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.write.mockResolvedValueOnce(null);
    expect((await row.create(post(row.body), params)).status).toBe(404);
    mocks.list.mockRejectedValueOnce(new mocks.AccessError('private text'));
    expect(await (await row.create(post(row.body), params)).text()).not.toContain('private text');
    expect(row.enqueue).not.toHaveBeenCalled();
  });
  it('accepts exact shared input and trusted session identity with 202; repeated ID is unchanged', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await row.create(post(row.body), params);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(row.task);
    }
    expect(row.enqueue).toHaveBeenCalledWith({ ...row.body, ...authorized, now: expect.any(Date) });
    expect(row.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenCalledWith(merchantId, 'synthetic-csrf');
    expect((await row.create(post({ ...row.body, userId: '0'.repeat(32) }), params)).status).toBe(
      400,
    );
    expect(row.enqueue).toHaveBeenCalledTimes(2);
  });
  it('rejects cross-kind read/find/cancel/retry before any mutation', async () => {
    mocks.get.mockResolvedValue(row.other);
    mocks.find.mockResolvedValue(row.other);
    expect((await row.get(new Request(url), params)).status).toBe(404);
    expect((await row.find(new Request(`${url}?requestId=${requestId}`), params)).status).toBe(404);
    expect((await row.cancel(post({}), params)).status).toBe(404);
    expect((await row.retry(post({ requestId }), params)).status).toBe(404);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
  });
  it('cancels with strict empty body and retries with explicit ID only', async () => {
    expect((await row.cancel(post({}), params)).status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(authorized, taskId, expect.any(Date));
    expect((await row.retry(post({ requestId }), params)).status).toBe(202);
    expect(mocks.retry).toHaveBeenCalledWith(authorized, taskId, requestId, expect.any(Date));
    expect((await row.cancel(post({ force: true }), params)).status).toBe(400);
    expect((await row.retry(post({ requestId, revision: 3 }), params)).status).toBe(400);
  });
  it.each([
    ['QUEUE_FULL', 429],
    ['INPUT_CHANGED', 409],
    ['RETRY_UNSAFE', 409],
    ['PREVIEW_SUPERSEDED', 409],
    ['UNAVAILABLE', 503],
    ['WRITE_OUTCOME_UNKNOWN', 503],
  ] as const)('maps %s without leaking internal error', async (code, status) => {
    row.enqueue.mockRejectedValue(new AuthoringTaskError(code));
    const response = await row.create(post(row.body), params);
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
  });
  it('keeps an unclassified POST failure unknown and an unclassified GET unavailable', async () => {
    row.enqueue.mockRejectedValue(new Error('private connection detail'));
    mocks.get.mockRejectedValue(new Error('private connection detail'));
    expect(await (await row.create(post(row.body), params)).json()).toMatchObject({
      code: 'WRITE_OUTCOME_UNKNOWN',
    });
    expect(await (await row.get(new Request(url), params)).json()).toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});
