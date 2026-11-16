import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeOrganizationClaim } from '@h5cs/database';
import {
  KnowledgeOrganizationProcessor,
  type KnowledgeOrganizationStore,
} from '../src/knowledge-organization-processor.js';
import {
  ModelRuntime,
  ModelCapacityError,
  ModelUnknownOutcomeError,
  type ModelAttemptStore,
} from '../src/model-runtime.js';
const signal = () => new AbortController().signal;
const claim = (merchantId = 'a'.repeat(32)): KnowledgeOrganizationClaim => ({
  jobId: 'd'.repeat(32),
  merchantId,
  assistantId: 'b'.repeat(32),
  requesterUserId: 'c'.repeat(32),
  leaseOwner: 'test_knowledge_owner',
  claimGeneration: '1',
  leaseUntil: new Date(Date.now() + 120000),
  text: '毛巾29元，运费未知。',
  payload: {
    schemaVersion: 1,
    handlerVersion: 'knowledge-organize-v1',
    merchantId,
    assistantId: 'b'.repeat(32),
    requesterUserId: 'c'.repeat(32),
    inputRevision: 1,
    requestHash: 'e'.repeat(64),
    sources: [{ id: 'f'.repeat(32), revision: 1, contentHash: 'e'.repeat(64), name: '合成.txt' }],
  },
});
function store() {
  return {
    claimNext: vi.fn<KnowledgeOrganizationStore['claimNext']>(async () => claim()),
    listRunnableMerchantHeads: vi.fn(async () => []),
    complete: vi.fn<KnowledgeOrganizationStore['complete']>(async () => 'applied'),
    fail: vi.fn<KnowledgeOrganizationStore['fail']>(async () => 'applied'),
    releaseBeforeDispatch: vi.fn<KnowledgeOrganizationStore['releaseBeforeDispatch']>(
      async () => 'applied',
    ),
    reconcile: vi.fn<KnowledgeOrganizationStore['reconcile']>(async () => ({
      state: 'processing',
      currentGeneration: '1',
      modelOutcome: 'unknown',
    })),
  };
}
const plan = JSON.stringify({ groups: [{ topic: '价格与适用条件', unitIds: ['u0'] }] });
const attempts = (): ModelAttemptStore => ({
  unknownRiskCount: async () => 0,
  markDispatch: vi.fn(async () => ({ attemptId: 'a'.repeat(32) })),
  recordOutcome: vi.fn(async () => {}),
});
describe('persistent knowledge uses the same runtime and original grounding', () => {
  it('keeps original source statements and binds organization dispatch to the claim', async () => {
    const s = store(),
      generate = vi.fn(async () => plan),
      p = new KnowledgeOrganizationProcessor(s, { generate }, 'test_owner');
    await p.processOnce(signal());
    expect(s.complete).toHaveBeenCalledOnce();
    expect(s.complete.mock.calls[0]![1].summary).toContain('毛巾29元，运费未知。');
    expect(generate.mock.calls[0]?.length).toBe(3);
    expect(s.fail).not.toHaveBeenCalled();
  });
  it('releases a capacity miss without failing or consuming a second model call', async () => {
    const s = store(),
      generate = vi.fn(async () => {
        throw new ModelCapacityError();
      }),
      p = new KnowledgeOrganizationProcessor(s, { generate }, 'test_owner');
    await p.processOnce(signal());
    expect(generate).toHaveBeenCalledOnce();
    expect(s.releaseBeforeDispatch).toHaveBeenCalledOnce();
    expect(s.fail).not.toHaveBeenCalled();
  });
  it('records unknown as terminal work and never invokes the generator again', async () => {
    const s = store(),
      generate = vi.fn(async () => {
        throw new ModelUnknownOutcomeError();
      }),
      p = new KnowledgeOrganizationProcessor(s, { generate }, 'test_owner');
    await p.processOnce(signal());
    expect(generate).toHaveBeenCalledOnce();
    expect(s.fail.mock.calls[0]?.[1]).toBe('MODEL_RESULT_UNKNOWN');
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('does not overwrite a completed receipt after a lost completion response', async () => {
    const s = store();
    s.complete.mockRejectedValueOnce(new Error('commit response lost'));
    s.reconcile.mockResolvedValue({
      state: 'completed',
      currentGeneration: '1',
      modelOutcome: 'succeeded',
    });
    await new KnowledgeOrganizationProcessor(
      s,
      { generate: async () => plan },
      'test_owner',
    ).processOnce(signal());
    expect(s.fail).not.toHaveBeenCalled();
  });
  it('rejects wrong knowledge permit generation before reserving a model attempt', async () => {
    const a = attempts(),
      runtime = new ModelRuntime(a);
    await expect(
      runtime.enqueueKnowledge('a'.repeat(32), signal(), async (permit) => {
        const c = claim();
        runtime.bindKnowledgeClaim(permit, c);
        return runtime.dispatch(
          {
            merchantId: c.merchantId,
            operation: 'organize',
            knowledgeClaim: { ...c, claimGeneration: '2' },
            permit,
          },
          signal(),
          async () => ({ value: 'never' }),
        );
      }),
    ).rejects.toBeInstanceOf(ModelCapacityError);
    expect(a.markDispatch).not.toHaveBeenCalled();
    await runtime.drain();
  });
  it('reserves one management slot while another merchant consumer can progress', async () => {
    const a = attempts(),
      runtime = new ModelRuntime(a),
      order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = runtime.enqueueKnowledge('A', signal(), async () => {
      order.push('knowledge-A');
      await gate;
    });
    await vi.waitFor(() => expect(order).toEqual(['knowledge-A']));
    const second = runtime.enqueueKnowledge('B', signal(), async () => {
      order.push('knowledge-B');
    });
    const consumer = runtime.enqueueConsumer('C', signal(), async () => {
      order.push('consumer-C');
      return 'ready';
    });
    await expect(consumer).resolves.toBe('ready');
    expect(order).toEqual(['knowledge-A', 'consumer-C']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['knowledge-A', 'consumer-C', 'knowledge-B']);
    await runtime.drain();
  });
  it('rotates persistent knowledge across merchants and shares the old synchronous slot', async () => {
    const runtime = new ModelRuntime(attempts(), 1),
      order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = runtime.enqueueKnowledge('A', signal(), async () => {
      order.push('A1');
      await gate;
    });
    await vi.waitFor(() => expect(order).toEqual(['A1']));
    const a2 = runtime.enqueueKnowledge('A', signal(), async () => {
      order.push('A2');
    });
    const a3 = runtime.enqueueKnowledge('A', signal(), async () => {
      order.push('A3');
    });
    const b1 = runtime.dispatch({ merchantId: 'B', operation: 'organize' }, signal(), async () => {
      order.push('B-sync');
      return { value: 'done' };
    });
    const b2 = runtime.enqueueKnowledge('B', signal(), async () => {
      order.push('B2');
    });
    const consumer = runtime.enqueueConsumer('C', signal(), async () => {
      order.push('C-consumer');
    });
    release();
    await Promise.all([first, a2, a3, b1, b2, consumer]);
    expect(order).toEqual(['A1', 'B-sync', 'C-consumer', 'A2', 'B2', 'A3']);
    await runtime.drain();
  });
});
