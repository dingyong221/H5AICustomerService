import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  config: vi.fn(),
  headers: vi.fn(),
  database: vi.fn(),
  change: vi.fn(),
  find: vi.fn(),
  read: vi.fn(),
  Error: class extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
}));
vi.mock('./operator-actions', () => ({ currentOperator: mocks.operator }));
vi.mock('./operator-auth', () => ({ loadOperatorAuthConfig: mocks.config }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: mocks.database,
  RuntimeControlError: mocks.Error,
  MySqlRuntimeExecutionControlRepository: class {
    change = mocks.change;
    findReceipt = mocks.find;
    read = mocks.read;
  },
}));
import { controlRuntime } from './runtime-control-actions';
const request = {
  scope: { kind: 'global' },
  action: 'pause',
  expectedRevision: '2',
  requestId: `runtime_${'a'.repeat(32)}`,
  reason: '核对供应商调用异常',
  confirmed: true,
};
const receipt = {
  requestId: request.requestId,
  scope: request.scope,
  scopeKey: 'global',
  action: 'pause',
  previousRevision: '2',
  revision: '3',
  state: 'manually_stopped',
  changedAt: '2026-11-17T00:00:00Z',
  auditId: 'b'.repeat(32),
};
const current = {
  scope: request.scope,
  scopeKey: 'global',
  enabled: true,
  state: 'active',
  revision: '4',
  changedAt: '2026-11-17T01:00:00Z',
  actorId: 'operator',
  reason: '已人工确认恢复',
  lastRequestId: `runtime_${'c'.repeat(32)}`,
  effectiveState: 'runnable',
  blockingScopes: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('RUNTIME_EXECUTION_CONTROL_ENABLED', 'true');
  mocks.operator.mockResolvedValue('operator');
  mocks.config.mockReturnValue({ publicOrigin: 'https://ops.test' });
  mocks.headers.mockResolvedValue(new Headers({ origin: 'https://ops.test' }));
  mocks.database.mockReturnValue({ configured: true, config: {} });
  mocks.change.mockResolvedValue(receipt);
  mocks.find.mockResolvedValue(receipt);
  mocks.read.mockResolvedValue(current);
});
afterEach(() => vi.unstubAllEnvs());
describe('authenticated runtime control boundary (mock persistence)', () => {
  it.each(['session', 'origin', 'config'])(
    'rejects invalid %s before database access, including receipt lookup',
    async (boundary) => {
      if (boundary === 'session') mocks.operator.mockResolvedValue(null);
      if (boundary === 'origin') mocks.headers.mockResolvedValue(new Headers());
      if (boundary === 'config') mocks.config.mockReturnValue(null);
      expect((await controlRuntime(request)).error).toBeTruthy();
      const lookup = await controlRuntime(request, true);
      expect(lookup.error).toBeTruthy();
      expect(lookup.uncertain).toBe(true);
      expect(mocks.database).not.toHaveBeenCalled();
    },
  );
  it.each([
    { confirmed: false },
    { expectedRevision: '02' },
    { reason: '短' },
    { operatorId: 'forged' },
    { scope: { kind: 'job', jobId: 'bad', merchantId: 'a'.repeat(32) } },
  ])('rejects malformed or extra input %j', async (override) => {
    expect((await controlRuntime({ ...request, ...override })).error).toBeTruthy();
    expect(mocks.change).not.toHaveBeenCalled();
  });
  it('default-off rejects writes but still allows original receipt reconciliation', async () => {
    vi.stubEnv('RUNTIME_EXECUTION_CONTROL_ENABLED', '');
    expect((await controlRuntime(request)).error).toContain('未启用');
    expect(mocks.change).not.toHaveBeenCalled();
    expect((await controlRuntime(request, true)).receipt).toEqual(receipt);
  });
  it('uses only session operator identity, exact CAS and request ID; rereads current after historical replay', async () => {
    const result = await controlRuntime(request);
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith({
      ...request,
      operatorId: 'operator',
      now: expect.any(Date),
    });
    expect(result.receipt?.revision).toBe('3');
    expect(result.current?.revision).toBe('4');
  });
  it('lost receipt reconciliation never mutates or invents a new ID', async () => {
    const result = await controlRuntime(request, true);
    expect(mocks.find).toHaveBeenCalledExactlyOnceWith({
      operatorId: 'operator',
      requestId: request.requestId,
    });
    expect(mocks.change).not.toHaveBeenCalled();
    expect(result.current).toEqual(current);
  });
  it('missing receipt retains uncertainty and still reads current state', async () => {
    mocks.find.mockResolvedValue(null);
    const result = await controlRuntime(request, true);
    expect(result.uncertain).toBe(true);
    expect(result.receipt).toBeNull();
    expect(result.current).toEqual(current);
  });
  it('CAS conflict is a known rejection and returns freshly read current state', async () => {
    mocks.change.mockRejectedValue(new mocks.Error('REVISION_CONFLICT'));
    const result = await controlRuntime(request);
    expect(result.uncertain).toBe(false);
    expect(result.error).toContain('修订已变化');
    expect(result.current?.revision).toBe('4');
  });
  it('unknown outcome preserves original reconciliation path and never exposes diagnostics', async () => {
    mocks.change.mockRejectedValue(new Error('sensitive diagnostic'));
    mocks.read.mockRejectedValue(new Error('database diagnostic'));
    const result = await controlRuntime(request);
    expect(result.uncertain).toBe(true);
    expect(result.current).toBeNull();
    expect(JSON.stringify(result)).not.toContain('diagnostic');
  });
  it('historical receipt with failed current query never fabricates active state', async () => {
    mocks.read.mockRejectedValue(new Error('offline'));
    const result = await controlRuntime(request, true);
    expect(result.receipt).toEqual(receipt);
    expect(result.current).toBeNull();
  });
});
