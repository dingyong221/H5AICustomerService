import { describe, expect, it, vi } from 'vitest';
import {
  KnowledgeOrganizationProcessor,
  type KnowledgeOrganizationStore,
} from '../src/knowledge-organization-processor.js';
import { KnowledgeOrganizationScheduler } from '../src/knowledge-organization-scheduler.js';
import { ModelRuntime, type ModelAttemptStore } from '../src/model-runtime.js';
const signal = () => new AbortController().signal;
function fixtures(risk = 0) {
  let pending = true;
  const store: KnowledgeOrganizationStore = {
    listRunnableMerchantHeads: vi.fn(async () =>
      pending ? [{ merchantId: 'A', oldestReadyAt: new Date(0) }] : [],
    ),
    claimNext: vi.fn(async () => {
      pending = false;
      return null;
    }),
    complete: vi.fn(async () => 'applied' as const),
    fail: vi.fn(async () => 'applied' as const),
    releaseBeforeDispatch: vi.fn(async () => 'applied' as const),
    reconcile: vi.fn(async () => ({
      state: 'processing',
      currentGeneration: '1',
      modelOutcome: 'none' as const,
    })),
  };
  const attempts: ModelAttemptStore = {
    unknownRiskCount: vi.fn(async () => risk),
    markDispatch: vi.fn(async () => ({ attemptId: 'synthetic' })),
    recordOutcome: vi.fn(async () => {}),
  };
  const runtime = new ModelRuntime(attempts),
    ready = vi.fn();
  const processor = new KnowledgeOrganizationProcessor(
    store,
    {
      generate: vi.fn(async () => {
        throw Error('must not call');
      }),
    },
    'test_scheduler',
  );
  const scheduler = new KnowledgeOrganizationScheduler(processor, runtime, ready);
  return { store, runtime, ready, scheduler, attempts };
}
describe('knowledge lazy scheduler', () => {
  it('reconciles heads but does not claim a lease when persisted risk fills capacity', async () => {
    const f = fixtures(2);
    f.scheduler.start();
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledWith(false));
    expect(f.store.listRunnableMerchantHeads).toHaveBeenCalled();
    expect(f.store.claimNext).not.toHaveBeenCalled();
    expect(f.attempts.markDispatch).not.toHaveBeenCalled();
    await f.scheduler.stop();
    await f.runtime.drain();
  });
  it('does not claim ticking leases while another management task owns the shared slot', async () => {
    const f = fixtures();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const occupied = f.runtime.enqueueKnowledge('B', signal(), async () => gate);
    await vi.waitFor(() => expect(f.runtime.queued).toBe(0));
    f.scheduler.start();
    await vi.waitFor(() => expect(f.ready).toHaveBeenCalledWith(true));
    expect(f.store.claimNext).not.toHaveBeenCalled();
    // A consumer can use the other slot while knowledge waits without a DB lease.
    await expect(f.runtime.enqueueConsumer('C', signal(), async () => 'served')).resolves.toBe(
      'served',
    );
    expect(f.store.claimNext).not.toHaveBeenCalled();
    release();
    await occupied;
    await vi.waitFor(() => expect(f.store.claimNext).toHaveBeenCalled());
    await f.scheduler.stop();
    await f.runtime.drain();
  });
  it('stop prevents a pending head refresh from admitting any new work', async () => {
    const f = fixtures();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(f.store.listRunnableMerchantHeads).mockImplementation(async () => {
      await gate;
      return [{ merchantId: 'A', oldestReadyAt: new Date(0) }];
    });
    f.scheduler.start();
    await vi.waitFor(() => expect(f.store.listRunnableMerchantHeads).toHaveBeenCalled());
    const stopped = f.scheduler.stop();
    release();
    await stopped;
    expect(f.store.claimNext).not.toHaveBeenCalled();
    await f.runtime.drain();
  });
});
