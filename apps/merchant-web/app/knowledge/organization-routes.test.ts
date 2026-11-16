import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  write: vi.fn(),
  list: vi.fn(),
  config: vi.fn(),
  enqueue: vi.fn(),
  get: vi.fn(),
  find: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  apply: vi.fn(),
  revalidate: vi.fn(),
  execution: vi.fn(),
  effective: vi.fn(),
  AccessError: class extends Error {},
}));
vi.mock('../account/merchant-actions', () => ({
  currentMerchant: mocks.current,
  currentMerchantForWrite: mocks.write,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@h5cs/database', async () => ({
  KnowledgeOrganizationError: (await import('@h5cs/domain')).KnowledgeOrganizationError,
  RuntimeExecutionBlockedError: (await import('@h5cs/domain')).RuntimeExecutionBlockedError,
  KnowledgeMaterialAccessError: mocks.AccessError,
  loadDatabaseConfig: mocks.config,
  MySqlKnowledgeMaterialRepository: class {
    list = mocks.list;
  },
  MySqlKnowledgeOrganizationRepository: class {
    getExecutionState = mocks.execution;
    enqueue = mocks.enqueue;
    get = mocks.get;
    findByRequest = mocks.find;
    cancel = mocks.cancel;
    retry = mocks.retry;
  },
  MySqlAssistantLifecycleRepository: class {
    applyKnowledgeOrganization = mocks.apply;
  },
  MySqlRuntimeExecutionControlRepository: class {
    readEffective = mocks.effective;
  },
}));
import { KnowledgeOrganizationError, RuntimeExecutionBlockedError } from '@h5cs/domain';
import {
  GET as find,
  POST as create,
} from '../[merchantId]/knowledge/[assistantId]/materials/organize-tasks/route';
import { GET as get } from '../[merchantId]/knowledge/[assistantId]/materials/organize-tasks/[taskId]/route';
import { POST as cancel } from '../[merchantId]/knowledge/[assistantId]/materials/organize-tasks/[taskId]/cancel/route';
import { POST as retry } from '../[merchantId]/knowledge/[assistantId]/materials/organize-tasks/[taskId]/retry/route';
import { POST as apply } from '../[merchantId]/knowledge/[assistantId]/materials/organize-tasks/[taskId]/apply/route';
const merchantId = 'aa'.repeat(16),
  assistantId = 'bb'.repeat(16),
  taskId = 'cc'.repeat(16),
  userId = 'dd'.repeat(16),
  sourceId = 'ee'.repeat(16);
const origin = 'https://h5cs.1rying.com';
const scope = { merchantId, assistantId, taskId },
  params = { params: Promise.resolve(scope) };
const requestId = `organize_${'11'.repeat(16)}`;
const body = { requestId, revision: 3, sourceIds: [sourceId], consent: true };
const task = {
  taskId,
  state: 'queued',
  inputRevision: 3,
  sources: [{ id: sourceId, revision: 1, contentHash: 'f'.repeat(64), name: '商品.txt' }],
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  modelOutcome: 'none',
  stale: false,
  canRetry: false,
  canApply: false,
};
const url = `${origin}/${merchantId}/knowledge/${assistantId}/materials/organize-tasks`;
function post(value: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'x-h5cs-csrf': 'test-csrf',
      ...headers,
    },
    body: JSON.stringify(value),
  });
}
describe('asynchronous knowledge task HTTP contract (mock persistence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MERCHANT_PUBLIC_ORIGIN', origin);
    mocks.config.mockReturnValue({ configured: true, config: {} });
    mocks.current.mockResolvedValue({ merchantUserId: userId });
    mocks.write.mockResolvedValue({ merchantUserId: userId });
    mocks.list.mockResolvedValue([]);
    for (const fn of [mocks.enqueue, mocks.get, mocks.find, mocks.cancel, mocks.retry])
      fn.mockResolvedValue(task);
    mocks.apply.mockResolvedValue({ saved: true, revision: 4 });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('reads by task and request ID with session auth and no write Origin or CSRF', async () => {
    expect((await get(new Request(`${url}/${taskId}`), params)).status).toBe(200);
    const response = await find(new Request(`${url}?requestId=${requestId}`), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(task);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.get).toHaveBeenCalledWith({ merchantId, assistantId, userId }, taskId);
    expect(mocks.find).toHaveBeenCalledWith({ merchantId, assistantId, userId }, requestId);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('returns only null for an authorized request not yet persisted and never enqueues from GET', async () => {
    mocks.find.mockResolvedValue(null);
    expect(
      await (await find(new Request(`${url}?requestId=${requestId}`), params)).json(),
    ).toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('keeps missing sessions and foreign task scopes indistinguishable', async () => {
    mocks.current.mockResolvedValueOnce(null);
    const denied = await get(new Request(url), params);
    mocks.get.mockRejectedValueOnce(new KnowledgeOrganizationError('NOT_FOUND'));
    const foreign = await get(new Request(url), params);
    expect(denied.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await denied.json());
  });
  it('rejects write origin and CSRF before consuming any body', async () => {
    for (const handler of [create, cancel, retry, apply]) {
      const request = post({}, { Origin: 'https://foreign.invalid' });
      const read = vi.spyOn(request.body!, 'getReader');
      expect((await handler(request, params)).status).toBe(404);
      expect(read).not.toHaveBeenCalled();
    }
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.write.mockResolvedValue(null);
    for (const handler of [create, cancel, retry, apply])
      expect((await handler(post({}), params)).status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('checks editable current assistant membership before writes and conceals foreign data', async () => {
    mocks.list.mockRejectedValue(new mocks.AccessError('private source'));
    const response = await create(post(body), params);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('private');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('passes only strict shared input and trusted session scope; repeated requests retain their ID', async () => {
    for (let i = 0; i < 2; i++) {
      const response = await create(post(body), params);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual(task);
    }
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      ...body,
      merchantId,
      assistantId,
      userId,
      now: expect.any(Date),
    });
    expect((await create(post({ ...body, userId: '00'.repeat(16) }), params)).status).toBe(400);
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...body, consent: false },
    { ...body, revision: 0 },
    { ...body, sourceIds: [sourceId, sourceId] },
    { ...body, requestId: 'bad' },
    { ...body, sourceIds: [] },
  ])('rejects invalid organization input before persistence: %j', async (input) => {
    expect((await create(post(input), params)).status).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('requires empty cancel body and a fresh valid retry request ID', async () => {
    expect((await cancel(post({}), params)).status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(
      { merchantId, assistantId, userId },
      taskId,
      expect.any(Date),
    );
    expect((await cancel(post({ confirmed: true }), params)).status).toBe(400);
    expect((await retry(post({ requestId }), params)).status).toBe(202);
    expect(mocks.retry).toHaveBeenCalledWith(
      { merchantId, assistantId, userId },
      taskId,
      requestId,
      expect.any(Date),
    );
    mocks.retry.mockRejectedValueOnce(new KnowledgeOrganizationError('RETRY_UNSAFE'));
    expect((await retry(post({ requestId }), params)).status).toBe(409);
  });
  it('binds explicit edited candidate adoption to task and expected revision; revalidates existing pages', async () => {
    const response = await apply(
      post({ revision: 3, summary: '人工核对后内容', mode: 'replace', confirmed: true }),
      params,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true, revision: 4 });
    expect(mocks.apply).toHaveBeenCalledWith({
      merchantId,
      assistantId,
      merchantUserId: userId,
      taskId,
      expectedRevision: 3,
      summary: '人工核对后内容',
      mode: 'replace',
      confirmed: true,
      now: expect.any(Date),
    });
    expect(mocks.revalidate).toHaveBeenCalledWith(`/${merchantId}/knowledge/${assistantId}`);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('rejects unconfirmed adoption, stale revisions, and unknown commits without fallback', async () => {
    const input = { revision: 3, summary: '候选', mode: 'append', confirmed: true };
    expect((await apply(post({ ...input, confirmed: false }), params)).status).toBe(400);
    mocks.apply.mockRejectedValueOnce(new KnowledgeOrganizationError('INPUT_CHANGED'));
    expect((await apply(post(input), params)).status).toBe(409);
    mocks.apply.mockRejectedValueOnce(new Error('private SQL detail'));
    const response = await apply(post(input), params);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
    expect(mocks.revalidate).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('maps disabled admission to 503 while still allowing reads and cancellation', async () => {
    vi.stubEnv('KNOWLEDGE_ASYNC_ENABLED', 'false');
    mocks.enqueue.mockRejectedValue(new KnowledgeOrganizationError('UNAVAILABLE'));
    expect((await create(post(body), params)).status).toBe(503);
    expect((await get(new Request(url), params)).status).toBe(200);
    expect((await cancel(post({}), params)).status).toBe(200);
  });
  it('bounds streamed inputs and rejects malformed task IDs without calling repositories', async () => {
    expect((await create(post({ ...body, padding: 'x'.repeat(2100) }), params)).status).toBe(400);
    expect(
      (await get(new Request(url), { params: Promise.resolve({ ...scope, taskId: '../other' }) }))
        .status,
    ).toBe(404);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('reads original task with enum header and unchanged JSON; GET needs neither Origin nor CSRF', async () => {
    mocks.execution.mockResolvedValue('draining');
    const response = await get(new Request(url), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-H5CS-Execution-State')).toBe('draining');
    expect(await response.json()).toEqual(task);
  });
  it('paused admission returns old UNAVAILABLE envelope and paused header without fallback', async () => {
    mocks.enqueue.mockRejectedValue(new RuntimeExecutionBlockedError());
    const response = await create(post(body), params);
    expect(response.status).toBe(503);
    expect(response.headers.get('X-H5CS-Execution-State')).toBe('paused');
    expect(await response.json()).toMatchObject({ code: 'UNAVAILABLE' });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });
  it('keeps adoption available while runtime paused and protects execution metadata on unauthorized reads', async () => {
    mocks.execution.mockResolvedValue('not-applicable');
    const response = await apply(
      post({ revision: 3, summary: '人工核对后内容', mode: 'replace', confirmed: true }),
      params,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-H5CS-Execution-State')).toBe('not-applicable');
    mocks.current.mockResolvedValue(null);
    expect((await get(new Request(url), params)).headers.has('X-H5CS-Execution-State')).toBe(false);
  });
  it('failed control probe never destroys an existing result', async () => {
    mocks.execution.mockRejectedValue(new Error('private diagnostic'));
    const response = await get(new Request(url), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-H5CS-Execution-State')).toBe('unavailable');
    expect(await response.json()).toEqual(task);
  });
});
