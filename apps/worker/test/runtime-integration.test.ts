import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationTurnClaim } from '@h5cs/database';
import { ModelRuntime, type ModelAttemptStore } from '../src/model-runtime.js';
import { ChatCompletionsGenerator } from '../src/chat-completions-generator.js';
import { PreviewService } from '../src/preview-service.js';
import {
  ConversationTurnProcessor,
  type ConversationTurnStore,
} from '../src/conversation-turn-processor.js';
import { ConversationScheduler } from '../src/conversation-scheduler.js';
import { startWorkerApplication } from '../src/worker-application.js';
import { WorkerHealth } from '../src/worker-health.js';

const response = (content: string) =>
  Response.json({
    object: 'chat.completion',
    id: 'fixture-request',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  });
const facts = {
  assistantName: '合成',
  industry: '合成',
  businessScope: '商品',
  materialsSummary: '毛巾',
  pricingSummary: '29 元/条',
  promotionSummary: '暂无优惠',
  insufficientInfoMessage: '需商家确认',
};
const prompt = {
  policy: 'test',
  confirmedFacts: '{}',
  history: [],
  question: '毛巾价格',
  insufficientInfoMessage: '需商家确认',
};
const config = {
  endpoint: 'http://127.0.0.1:9000/chat/completions',
  model: 'local-runtime-test',
  apiKey: 'local-fixture-synthetic-only',
};
const attempts = () => {
  const outcomes = new Map<string, string>();
  return {
    outcomes,
    markDispatch: vi.fn<ModelAttemptStore['markDispatch']>(async () => {
      const attemptId = String(outcomes.size + 1);
      outcomes.set(attemptId, 'dispatched');
      return { attemptId };
    }),
    recordOutcome: vi.fn<ModelAttemptStore['recordOutcome']>(async (id, result) => {
      outcomes.set(id, result);
    }),
    unknownRiskCount: async () =>
      [...outcomes.values()].filter((value) => ['unknown', 'dispatched'].includes(value)).length,
  };
};
function turn(merchantId: string, index: number): ConversationTurnClaim {
  return {
    jobId: String(index),
    leaseOwner: 'fixture',
    claimGeneration: '1',
    leaseUntil: new Date(Date.now() + 120_000),
    payloadVersion: 0,
    merchantId,
    assistantId: 'assistant',
    sessionId: `session-${index}`,
    releaseId: 'pinned-release',
    turnId: String(index),
    visitorMessageId: String(index),
    question: '毛巾多少钱',
    context: [],
    facts: { ...facts, displayName: facts.assistantName },
  };
}
function queueStore(initial: ConversationTurnClaim[]) {
  const pending = [...initial];
  const completed: string[] = [];
  const claimNext = vi.fn<ConversationTurnStore['claimNext']>(async (_now, _owner, options) => {
    const index = pending.findIndex(
      (claim) => !options?.merchantId || claim.merchantId === options.merchantId,
    );
    return index < 0 ? null : pending.splice(index, 1)[0]!;
  });
  const store: ConversationTurnStore = {
    claimNext,
    listRunnableMerchantHeads: async (_now, options) =>
      [...new Set(pending.map((item) => item.merchantId))]
        .sort()
        .filter((id) => !options?.afterMerchantId || id > options.afterMerchantId)
        .slice(0, options?.limit ?? 64)
        .map((merchantId) => ({ merchantId, oldestReadyAt: new Date(0) })),
    complete: async (claim) => {
      completed.push(claim.jobId);
      return 'applied';
    },
    fail: async () => 'applied',
    releaseBeforeDispatch: async () => 'applied',
    reconcile: async (claim) => ({
      state: 'processing',
      currentGeneration: claim.claimGeneration,
      modelOutcome: 'succeeded',
    }),
  };
  return { pending, completed, claimNext, store };
}

describe('shared worker execution integration', () => {
  it('uses the same two slots for consumer, preview, writing and organization entry points', async () => {
    const receipts = attempts();
    const runtime = new ModelRuntime(receipts);
    const finish: Array<(value: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish.push(resolve);
        }),
    );
    const assertAccess = vi.fn(async () => undefined);
    const generator = new ChatCompletionsGenerator(
      config,
      fetchImpl,
      undefined,
      assertAccess,
      runtime,
    );
    const service = new PreviewService(randomBytes(32).toString('base64url'), generator);
    const signals = () => new AbortController().signal;
    const jobs = [
      generator.generate(prompt, signals(), {
        merchantId: 'aa'.repeat(16),
        operation: 'consumer',
        claim: turn('aa'.repeat(16), 1),
      }),
      service.reply({ merchantId: 'bb'.repeat(16), facts, question: '毛巾价格' }, signals()),
      service.write(
        {
          merchantId: 'cc'.repeat(16),
          field: 'pricingSummary',
          brief: '毛巾29元每条，运费待确认',
          currentText: '',
        },
        signals(),
      ),
      service.organize({ merchantId: 'dd'.repeat(16), text: '毛巾29元每条。' }, signals()),
    ];
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    finish[0]!(response('29元每条。'));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    finish[1]!(response('29元每条。'));
    await vi.waitFor(() => expect(runtime.active).toBe(1));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    finish[2]!(
      response(JSON.stringify({ options: ['毛巾29元每条。', '每条毛巾29元。'], reminders: [] })),
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    finish[3]!(
      response(
        JSON.stringify({ groups: [{ topic: '商品/服务', unitIds: ['u0'] }], reviewUnitIds: [] }),
      ),
    );
    await Promise.all(jobs);
    expect(receipts.markDispatch.mock.calls.map(([scope]) => scope.operation)).toEqual([
      'consumer',
      'preview',
      'writing',
      'organize',
    ]);
    expect(receipts.recordOutcome.mock.calls.every(([, result]) => result === 'succeeded')).toBe(
      true,
    );
    expect(assertAccess).toHaveBeenCalledTimes(4);
    await runtime.drain();
  });

  it('checks deterministic answer eligibility without reserving supplier capacity or fees', async () => {
    const receipts = attempts();
    const runtime = new ModelRuntime(receipts);
    const fetchImpl = vi.fn<typeof fetch>();
    const access = vi.fn(async () => undefined);
    const generator = new ChatCompletionsGenerator(config, fetchImpl, undefined, access, runtime);
    await expect(
      generator.generate({ ...prompt, question: '转人工' }, new AbortController().signal, {
        merchantId: 'A',
        operation: 'preview',
      }),
    ).resolves.toContain('不实时转接');
    expect(access).toHaveBeenCalledOnce();
    expect(runtime.active).toBe(0);
    expect(receipts.markDispatch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    access.mockRejectedValueOnce(new Error('merchant access revoked'));
    await expect(
      generator.generate({ ...prompt, question: '转人工' }, new AbortController().signal, {
        merchantId: 'A',
        operation: 'preview',
      }),
    ).rejects.toThrow('merchant access revoked');
    expect(receipts.markDispatch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await runtime.drain();
  });

  it('keeps DB merchant heads and HTTP waiters visible, claims only selected work and immediately replenishes', async () => {
    const receipts = attempts();
    const runtime = new ModelRuntime(receipts);
    const fixture = queueStore([turn('A', 1), turn('A', 2), turn('A', 3), turn('A', 4)]);
    const starts: string[] = [];
    const finish: Array<(value: { value: string }) => void> = [];
    const generator = {
      generate: async (
        _prompt: unknown,
        signal: AbortSignal,
        scope?: {
          merchantId: string;
          operation: string;
          claim?: ConversationTurnClaim;
          permit?: Parameters<ModelRuntime['bindClaim']>[0];
        },
      ) => {
        if (!scope) throw new Error('missing scope');
        return runtime.dispatch({ ...scope, operation: 'consumer' }, signal, async () => {
          starts.push(scope.merchantId);
          return new Promise<{ value: string }>((resolve) => {
            finish.push(resolve);
          });
        });
      },
    };
    const processor = new ConversationTurnProcessor(fixture.store, generator, 'fixture');
    const scheduler = new ConversationScheduler(processor, runtime);
    scheduler.start();
    await vi.waitFor(() => expect(starts).toEqual(['A', 'A']));
    // The third accepted A question is still a DB head, without a ticking lease.
    expect(fixture.claimNext).toHaveBeenCalledTimes(2);
    fixture.pending.push(turn('B', 5));
    scheduler.wake();
    const http = runtime.dispatch(
      { merchantId: 'C', operation: 'preview' },
      new AbortController().signal,
      async () => {
        starts.push('C');
        return { value: 'http' };
      },
    );
    await vi.waitFor(() => expect(runtime.queued).toBeGreaterThanOrEqual(3));
    finish[0]!({ value: 'A answer' });
    await vi.waitFor(() => expect(starts[2]).toBe('B'), { timeout: 1_000 });
    finish[1]!({ value: 'A answer' });
    await vi.waitFor(() => expect(starts).toContain('C'), { timeout: 1_000 });
    await http;
    await scheduler.stop();
    runtime.stopAdmission();
    finish.forEach((resolve) => resolve({ value: 'answer' }));
    await runtime.drain(1_000);
    expect(fixture.completed).toContain('1');
    expect(fixture.completed).toContain('2');
  });

  it('dispatches every merchant beyond a full waiting queue while the first merchants stay backlogged', async () => {
    const merchantIds = Array.from(
      { length: 80 },
      (_, index) => `M${String(index).padStart(3, '0')}`,
    );
    const fixture = queueStore(
      merchantIds.map((merchantId, index) => ({
        ...turn(merchantId, index),
        question: `${merchantId}商品多少钱`,
      })),
    );
    // Keep the first page busy: a fresh first-page turn is ready before every
    // slot is replenished. Merely observing a later page does not pass this test.
    fixture.pending.push(
      ...merchantIds.slice(0, 6).flatMap((merchantId, merchantIndex) =>
        Array.from({ length: 160 }, (_, index) => ({
          ...turn(merchantId, 1000 + merchantIndex * 160 + index),
          question: `${merchantId}商品多少钱`,
        })),
      ),
    );
    const runtime = new ModelRuntime(attempts(), 2, 4);
    const dispatched: string[] = [];
    const fetched: string[] = [];
    const finish: Array<(value: Response) => void> = [];
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      fetched.push(body.messages.at(-1)!.content.slice(0, 4));
      return new Promise<Response>((resolve) => {
        finish.push(resolve);
      });
    });
    const generator = new ChatCompletionsGenerator(
      config,
      fetchImpl,
      undefined,
      async () => undefined,
      runtime,
    );
    const claimNext = vi.fn<ConversationTurnStore['claimNext']>(async (...args) => {
      const claim = await fixture.store.claimNext(...args);
      if (claim) dispatched.push(claim.merchantId);
      return claim;
    });
    const scheduler = new ConversationScheduler(
      new ConversationTurnProcessor({ ...fixture.store, claimNext }, generator, 'fixture'),
      runtime,
    );
    scheduler.start();
    let released = 0;
    try {
      for (let batch = 0; batch < 90 && new Set(fetched).size < merchantIds.length; batch += 1) {
        await vi.waitFor(() => expect(finish.length).toBeGreaterThan(released), {
          timeout: 1_000,
          interval: 1,
        });
        const available = finish.length;
        while (released < available) finish[released++]!(response('29元每条。'));
        scheduler.wake();
      }
      expect(new Set(dispatched)).toEqual(new Set(merchantIds));
      expect(new Set(fetched)).toEqual(new Set(merchantIds));
      expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(180);
      expect(fixture.pending.some((claim) => claim.merchantId === merchantIds[0])).toBe(true);
    } finally {
      await scheduler.stop();
      runtime.stopAdmission();
      finish.forEach((resolve) => resolve(response('29元每条。')));
      await runtime.drain(1_000);
    }
  });

  it('keeps an over-budget supplier call unknown and rejects its late answer after shutdown', async () => {
    const receipts = attempts();
    const runtime = new ModelRuntime(receipts);
    const fixture = queueStore([turn('A', 1)]);
    const complete = vi.fn(fixture.store.complete);
    const fail = vi.fn(fixture.store.fail);
    let finish!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const generator = new ChatCompletionsGenerator(
      config,
      fetchImpl,
      undefined,
      async () => undefined,
      runtime,
    );
    const scheduler = new ConversationScheduler(
      new ConversationTurnProcessor(
        {
          ...fixture.store,
          complete,
          fail,
          releaseBeforeDispatch: async () => 'stale',
          reconcile: async () => ({
            state: 'processing',
            currentGeneration: '1',
            modelOutcome: 'unknown',
          }),
        },
        generator,
        'fixture',
      ),
      runtime,
    );
    scheduler.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await scheduler.stop();
    await expect(runtime.drain(5)).resolves.toBe('aborted');
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ merchantId: 'A' }),
      'MODEL_RESULT_UNKNOWN',
      expect.any(Date),
    );
    expect(complete).not.toHaveBeenCalled();
    const late = response('29元每条，迟到回答。');
    finish(late);
    await vi.waitFor(() => expect(late.bodyUsed).toBe(true));
    expect(complete).not.toHaveBeenCalled();
    expect([...receipts.outcomes.values()]).toEqual(['unknown']);
    expect(receipts.recordOutcome).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('waits before claiming when one persisted unknown and one local call use the risk budget, then progresses every merchant', async () => {
    const receipts = attempts();
    receipts.outcomes.set('previous-process', 'unknown');
    const runtime = new ModelRuntime(receipts);
    let finishActive!: (value: { value: string }) => void;
    const active = runtime.dispatch(
      { merchantId: 'A', operation: 'preview' },
      new AbortController().signal,
      () =>
        new Promise<{ value: string }>((resolve) => {
          finishActive = resolve;
        }),
    );
    await vi.waitFor(() => expect(runtime.active).toBe(1));
    const merchants = ['B', 'C', 'D', 'E', 'F', 'G'];
    const fixture = queueStore(merchants.map((id, index) => turn(id, index)));
    fixture.pending.push(...Array.from({ length: 20 }, (_, index) => turn('B', 100 + index)));
    const claimedAttempts = new Map<string, number>();
    const failures: string[] = [];
    const claimNext = vi.fn<ConversationTurnStore['claimNext']>(async (...args) => {
      const claim = await fixture.store.claimNext(...args);
      if (!claim) return null;
      const count = (claimedAttempts.get(claim.jobId) ?? 0) + 1;
      claimedAttempts.set(claim.jobId, count);
      if (count > 5) {
        failures.push('MAX_ATTEMPTS');
        return null;
      }
      return { ...claim, claimGeneration: String(count) };
    });
    const generator = new ChatCompletionsGenerator(
      config,
      vi.fn<typeof fetch>(async () => response('29元每条。')),
      undefined,
      async () => undefined,
      runtime,
    );
    const scheduler = new ConversationScheduler(
      new ConversationTurnProcessor(
        {
          ...fixture.store,
          claimNext,
          fail: async (_claim, code) => {
            failures.push(code);
            return 'applied';
          },
          releaseBeforeDispatch: async (claim) => {
            fixture.pending.push(claim);
            return 'applied';
          },
        },
        generator,
        'fixture',
      ),
      runtime,
    );
    scheduler.start();
    try {
      // Multiple scheduling/recheck cycles must not consume five DB attempts.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(claimNext).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
      expect(receipts.markDispatch).toHaveBeenCalledOnce();
      await expect(runtime.probeReadiness()).resolves.toBe(true);
      finishActive({ value: 'original active answer' });
      await active;
      await vi.waitFor(() =>
        expect(merchants.every((_id, index) => fixture.completed.includes(String(index)))).toBe(
          true,
        ),
      );
      expect(failures).toEqual([]);
      expect([...claimedAttempts.values()].every((count) => count === 1)).toBe(true);
    } finally {
      finishActive({ value: 'cleanup' });
      await active;
      await scheduler.stop();
      await runtime.drain(1_000);
    }
  });

  it('releases a final risk admission race once without consuming five attempts, then completes the same question', async () => {
    const receipts = attempts();
    const runtime = new ModelRuntime(receipts);
    const fixture = queueStore([turn('A', 1)]);
    let attemptCount = 0;
    const failures: string[] = [];
    const claimNext = vi.fn<ConversationTurnStore['claimNext']>(async (...args) => {
      const claim = await fixture.store.claimNext(...args);
      if (!claim) return null;
      attemptCount += 1;
      if (attemptCount > 5) {
        failures.push('MAX_ATTEMPTS');
        return null;
      }
      if (attemptCount === 1) {
        // Persisted risk changes after the permit check, before markDispatch.
        receipts.outcomes.set('race-one', 'unknown');
        receipts.outcomes.set('race-two', 'unknown');
      }
      return { ...claim, claimGeneration: String(attemptCount) };
    });
    const release = vi.fn<ConversationTurnStore['releaseBeforeDispatch']>(async (claim) => {
      fixture.pending.push(claim);
      return 'applied';
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => response('29元每条。'));
    const generator = new ChatCompletionsGenerator(
      config,
      fetchImpl,
      undefined,
      async () => undefined,
      runtime,
    );
    const scheduler = new ConversationScheduler(
      new ConversationTurnProcessor(
        {
          ...fixture.store,
          claimNext,
          releaseBeforeDispatch: release,
          fail: async (_claim, code) => {
            failures.push(code);
            return 'applied';
          },
        },
        generator,
        'fixture',
      ),
      runtime,
    );
    scheduler.start();
    try {
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(attemptCount).toBe(1);
      expect(failures).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
      receipts.outcomes.set('race-one', 'succeeded');
      receipts.outcomes.set('race-two', 'succeeded');
      scheduler.wake();
      await vi.waitFor(() => expect(fixture.completed).toEqual(['1']));
      expect(attemptCount).toBe(2);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(failures).toEqual([]);
    } finally {
      await scheduler.stop();
      await runtime.drain(1_000);
    }
  });

  it('serves liveness before the first database probe resolves and fails readiness closed', async () => {
    const health = new WorkerHealth();
    let release!: () => void;
    vi.spyOn(health, 'probeDatabase').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const application = await startWorkerApplication({
      health,
      dispatch: { configured: false, reason: 'fixture' },
      preview: null,
      host: '127.0.0.1',
      port: 0,
    });
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('missing listen address');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    release();
    await application.stop();
  });

  it.each(['missing receipt table', 'missing job claim columns', 'persisted risk brake'] as const)(
    'keeps readiness closed for %s before claiming or dispatching',
    async (fault) => {
      const health = new WorkerHealth();
      vi.spyOn(health, 'probeDatabase').mockResolvedValue();
      vi.spyOn(health, 'databaseAvailable').mockReturnValue(true);
      const receipts = attempts();
      const riskProbe = vi.fn(async () => {
        if (fault === 'missing receipt table')
          throw Object.assign(new Error('Table model_call_attempt does not exist'), {
            code: 'ER_NO_SUCH_TABLE',
          });
        return fault === 'persisted risk brake' ? 2 : 0;
      });
      const runtime = new ModelRuntime({ ...receipts, unknownRiskCount: riskProbe });
      const fixture = queueStore([turn('A', 1)]);
      const listHeads = vi.fn<ConversationTurnStore['listRunnableMerchantHeads']>(async () => {
        if (fault === 'missing job claim columns')
          throw Object.assign(new Error('Unknown column claim_generation'), {
            code: 'ER_BAD_FIELD_ERROR',
          });
        return [{ merchantId: 'A', oldestReadyAt: new Date(0) }];
      });
      const generate = vi.fn(async () => 'unused');
      const processor = new ConversationTurnProcessor(
        { ...fixture.store, listRunnableMerchantHeads: listHeads },
        { generate },
        'fixture',
      );
      const application = await startWorkerApplication({
        health,
        dispatch: { configured: true, processor, runtime },
        preview: null,
        host: '127.0.0.1',
        port: 0,
      });
      const address = application.server.address();
      if (!address || typeof address === 'string') throw new Error('missing listen address');
      await vi.waitFor(() => expect(riskProbe).toHaveBeenCalled());
      expect((await fetch(`http://127.0.0.1:${address.port}/readyz`)).status).toBe(503);
      if (fault === 'missing job claim columns') expect(listHeads).toHaveBeenCalled();
      else expect(listHeads).not.toHaveBeenCalled();
      expect(fixture.claimNext).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
      expect(receipts.markDispatch).not.toHaveBeenCalled();
      await application.stop();
    },
  );
});
