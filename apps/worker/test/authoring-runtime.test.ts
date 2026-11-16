import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { AuthoringTaskClaim } from '@h5cs/database';
import {
  AuthoringTaskProcessor,
  type AuthoringTaskStore,
} from '../src/authoring-task-processor.js';
import {
  ModelRuntime,
  ModelCapacityError,
  ModelUnknownOutcomeError,
  type ModelAttemptStore,
} from '../src/model-runtime.js';
const signal = () => new AbortController().signal;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const claim = (): AuthoringTaskClaim => ({
  jobId: 'a'.repeat(32),
  merchantId: 'b'.repeat(32),
  assistantId: 'c'.repeat(32),
  requesterUserId: 'd'.repeat(32),
  leaseOwner: 'test_authoring',
  claimGeneration: '1',
  leaseUntil: new Date(Date.now() + 120000),
  payload: {
    schemaVersion: 1,
    kind: 'draft.expand',
    handlerVersion: 'draft-expand-v1',
    merchantId: 'b'.repeat(32),
    assistantId: 'c'.repeat(32),
    requesterUserId: 'd'.repeat(32),
    inputRevision: 1,
    requestHash: 'f'.repeat(64),
    input: {
      requestId: 'authoring_' + 'e'.repeat(32),
      revision: 1,
      field: 'industry',
      brief: '家居零售',
      currentText: ' 家居 ',
      consent: true,
    },
    inputFieldHash: hash(' 家居 '),
  },
});
function store() {
  return {
    claimNext: vi.fn<AuthoringTaskStore['claimNext']>(async () => claim()),
    listRunnableMerchantHeads: vi.fn(async () => []),
    complete: vi.fn<AuthoringTaskStore['complete']>(async () => 'applied'),
    fail: vi.fn<AuthoringTaskStore['fail']>(async () => 'applied'),
    releaseBeforeDispatch: vi.fn<AuthoringTaskStore['releaseBeforeDispatch']>(
      async () => 'applied',
    ),
    reconcile: vi.fn<AuthoringTaskStore['reconcile']>(async () => ({
      state: 'processing',
      currentGeneration: '1',
      modelOutcome: 'unknown',
    })),
  };
}
const attempts = (): ModelAttemptStore => ({
  unknownRiskCount: vi.fn(async () => 0),
  markDispatch: vi.fn(async () => ({ attemptId: 'a'.repeat(32) })),
  recordOutcome: vi.fn(async () => {}),
});
const options = JSON.stringify({
  options: ['家居用品零售', '家居日用品商店'],
  reminders: ['核对业务范围'],
});
describe('authoring through original generation and one shared runtime', () => {
  it('produces a candidate without saving any draft and carries the exact task claim', async () => {
    const s = store(),
      generate = vi.fn(async () => options);
    await new AuthoringTaskProcessor(s, { generate }, 'test_owner').processOnce(
      signal(),
      'b'.repeat(32),
      'draft.expand',
    );
    expect(s.complete).toHaveBeenCalledOnce();
    expect(s.complete.mock.calls[0]?.[1]).toEqual(JSON.parse(options));
    expect((generate.mock.calls[0] as unknown[])[2]).toMatchObject({
      operation: 'writing',
      authoringClaim: expect.objectContaining({ claimGeneration: '1' }),
    });
    expect(s.fail).not.toHaveBeenCalled();
  });
  it('keeps financial grounding when a persistent model tries to invent prices', async () => {
    const s = store(),
      c = claim();
    if (c.payload.kind !== 'draft.expand') throw Error();
    s.claimNext.mockResolvedValue({
      ...c,
      payload: {
        ...c.payload,
        input: {
          ...c.payload.input,
          field: 'pricingSummary',
          brief: '毛巾29元，运费需确认。',
          currentText: '毛巾29元，运费需确认。',
        },
        inputFieldHash: hash('毛巾29元，运费需确认。'),
      },
    });
    await new AuthoringTaskProcessor(
      s,
      {
        generate: async () =>
          JSON.stringify({ options: ['毛巾9元，包邮', '毛巾19元，全场免运费'], reminders: [] }),
      },
      'test_owner',
    ).processOnce(signal(), c.merchantId, 'draft.expand');
    const rendered = JSON.stringify(s.complete.mock.calls[0]?.[1]);
    expect(rendered).not.toMatch(/(?<!\d)9元/u);
    expect(rendered).not.toContain('19元');
    expect(rendered).not.toContain('包邮');
    expect(rendered).toContain('29元');
  });
  it('unknown never triggers another generation and retains the terminal risk code', async () => {
    const s = store(),
      generate = vi.fn(async () => {
        throw new ModelUnknownOutcomeError();
      });
    await new AuthoringTaskProcessor(s, { generate }, 'test_owner').processOnce(
      signal(),
      'b'.repeat(32),
      'draft.expand',
    );
    expect(generate).toHaveBeenCalledOnce();
    expect(s.fail.mock.calls[0]?.[1]).toBe('MODEL_RESULT_UNKNOWN');
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('completion acknowledgement loss reconciles without overwriting completed business state', async () => {
    const s = store();
    s.complete.mockRejectedValueOnce(Error('synthetic lost response'));
    s.reconcile.mockResolvedValue({
      state: 'completed',
      currentGeneration: '1',
      modelOutcome: 'succeeded',
    });
    await new AuthoringTaskProcessor(
      s,
      { generate: async () => options },
      'test_owner',
    ).processOnce(signal(), 'b'.repeat(32), 'draft.expand');
    expect(s.fail).not.toHaveBeenCalled();
  });
  it('rejects type/generation permit confusion before reserving any fee', async () => {
    const a = attempts(),
      runtime = new ModelRuntime(a),
      c = claim();
    await expect(
      runtime.enqueueAuthoring(c.merchantId, 'writing', signal(), async (permit) => {
        runtime.bindAuthoringClaim(permit, c);
        return runtime.dispatch(
          { merchantId: c.merchantId, operation: 'preview', authoringClaim: c, permit },
          signal(),
          async () => ({ value: 'never' }),
        );
      }),
    ).rejects.toBeInstanceOf(ModelCapacityError);
    expect(a.markDispatch).not.toHaveBeenCalled();
    await runtime.drain();
  });
  it('writing and knowledge share one management slot while preview and consumer progress', async () => {
    const runtime = new ModelRuntime(attempts()),
      order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = runtime.enqueueAuthoring('A', 'writing', signal(), async () => {
      order.push('writing');
      await gate;
    });
    await vi.waitFor(() => expect(order).toEqual(['writing']));
    const k = runtime.enqueueKnowledge('B', signal(), async () => {
      order.push('knowledge');
    });
    await runtime.enqueueAuthoring('C', 'preview', signal(), async () => {
      order.push('preview');
    });
    await runtime.enqueueConsumer('D', signal(), async () => {
      order.push('consumer');
    });
    expect(order).toEqual(['writing', 'preview', 'consumer']);
    release();
    await Promise.all([a, k]);
    expect(order.at(-1)).toBe('knowledge');
    await runtime.drain();
  });
});
