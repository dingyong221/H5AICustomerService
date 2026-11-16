import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  operator: vi.fn(),
  database: vi.fn(),
  read: vi.fn(),
  observe: vi.fn(),
  worker: vi.fn(),
}));
vi.mock('./operator-actions', () => ({ currentOperator: mocks.operator }));
vi.mock('./runtime-control-form', () => ({ RuntimeControlForm: () => <div>控制表单</div> }));
vi.mock('./runtime-observation', () => ({ readWorkerObservation: mocks.worker }));
vi.mock('@h5cs/database', () => ({
  loadDatabaseConfig: mocks.database,
  MySqlRuntimeExecutionControlRepository: class {
    read = mocks.read;
  },
  MySqlRuntimeObservationRepository: class {
    read = mocks.observe;
  },
}));
import { RuntimePanel, RuntimeScopeControl, runtimeQuery } from './runtime-panel';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.operator.mockResolvedValue('operator');
  mocks.database.mockReturnValue({ configured: false });
  mocks.worker.mockResolvedValue({ snapshot: null, error: 'Worker 独立观测暂不可用；计数未知。' });
});
describe('runtime query and source-separated server UI', () => {
  it.each([
    { runtimeFrom: ['bad', 'duplicate'] },
    { runtimeFrom: 'bad' },
    { runtimeFrom: '2026-09-01T00:00', runtimeTo: '2026-11-17T00:00' },
    { runtimeMerchant: 'other' },
    { runtimeType: 'unregistered' },
    { runtimeCursor: 'a'.repeat(1025) },
  ])('rejects invalid filter without silently widening scope %j', (params) => {
    expect(() => runtimeQuery(params)).toThrow();
  });
  it('keeps exact UTC window and explicit merchant/type filters', () => {
    const query = runtimeQuery({
      runtimeFrom: '2026-11-16T00:00',
      runtimeTo: '2026-11-17T00:00',
      runtimeMerchant: 'a'.repeat(32),
      runtimeType: 'preview.reply',
    });
    expect(query.from.toISOString()).toBe('2026-11-16T00:00:00.000Z');
    expect(query.to.toISOString()).toBe('2026-11-17T00:00:00.000Z');
    expect(query).toMatchObject({ merchantId: 'a'.repeat(32), type: 'preview.reply', limit: 20 });
  });
  it('requires operator session before database or internal Worker access', async () => {
    mocks.operator.mockResolvedValue(null);
    expect(await RuntimePanel({ params: {} })).toBeNull();
    expect(await RuntimeScopeControl({ scope: { kind: 'global' }, label: '全局' })).toBeNull();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
  });
  it('unavailable sources are separately named and never rendered as zero', async () => {
    const html = JSON.stringify(await RuntimePanel({ params: {} }));
    expect(html).toContain('数据库运行观测');
    expect(html).toContain('Worker进程观测');
    expect(html).toContain('计数与分位数均未知');
    expect(html).toContain('Worker 独立观测暂不可用');
    expect(html).not.toContain('暂无任务');
    expect(html).toContain('datetime-local');
  });
});
