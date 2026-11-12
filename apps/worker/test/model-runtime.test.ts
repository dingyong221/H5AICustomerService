import { describe, expect, it, vi } from 'vitest';
import {
  ModelRuntime,
  ModelCapacityError,
  ModelUnknownOutcomeError,
  type ModelAttemptStore,
  type ModelContext,
} from '../src/model-runtime.js';

export function memoryAttempts() {
  const receipts = new Map<string, string>();
  const markDispatch = vi.fn<ModelAttemptStore['markDispatch']>(async () => {
    const attemptId = String(receipts.size + 1);
    receipts.set(attemptId, 'dispatched');
    return { attemptId };
  });
  const recordOutcome = vi.fn<ModelAttemptStore['recordOutcome']>(async (id, outcome) => {
    receipts.set(id, outcome);
  });
  return {
    receipts,
    markDispatch,
    recordOutcome,
    unknownRiskCount: async () =>
      [...receipts.values()].filter((value) => value === 'unknown' || value === 'dispatched')
        .length,
  };
}
const signal = () => new AbortController().signal;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};
const context = (
  merchantId: string,
  operation: ModelContext['operation'] = 'preview',
): ModelContext => ({ merchantId, operation });

describe('single-instance fair model runtime', () => {
  it('shares two supplier slots across all operations and permits same-merchant borrowing', async () => {
    const attempts = memoryAttempts();
    const runtime = new ModelRuntime(attempts);
    const gates = Array.from({ length: 4 }, () => deferred<{ value: string }>());
    const calls = gates.map((gate, index) =>
      runtime.dispatch(
        context(
          'same',
          ['consumer', 'preview', 'writing', 'organize'][index] as ModelContext['operation'],
        ),
        signal(),
        () => gate.promise,
      ),
    );
    await vi.waitFor(() => expect(runtime.active).toBe(2));
    await expect(runtime.probeReadiness()).resolves.toBe(true);
    expect(attempts.markDispatch).toHaveBeenCalledTimes(2);
    expect(attempts.markDispatch.mock.calls.every(([scope]) => scope.merchantId === 'same')).toBe(
      true,
    );
    gates[0]!.resolve({ value: 'consumer' });
    await vi.waitFor(() => expect(attempts.markDispatch).toHaveBeenCalledTimes(3));
    gates[1]!.resolve({ value: 'preview' });
    // Writing and organization may never occupy both slots.
    await vi.waitFor(() => expect(runtime.active).toBe(1));
    expect(attempts.markDispatch).toHaveBeenCalledTimes(3);
    gates[2]!.resolve({ value: 'writing' });
    await vi.waitFor(() => expect(attempts.markDispatch).toHaveBeenCalledTimes(4));
    gates[3]!.resolve({ value: 'organize' });
    expect(await Promise.all(calls)).toEqual(['consumer', 'preview', 'writing', 'organize']);
    await expect(runtime.drain()).resolves.toBe('drained');
  });

  it('cancels waiting work without claiming supplier quota or recording dispatch', async () => {
    const attempts = memoryAttempts();
    const runtime = new ModelRuntime(attempts);
    const gate = deferred<{ value: string }>();
    const active = [0, 1].map(() =>
      runtime.dispatch(context('busy'), signal(), () => gate.promise),
    );
    await vi.waitFor(() => expect(runtime.active).toBe(2));
    const cancelled = new AbortController();
    const call = runtime.dispatch(context('waiting'), cancelled.signal, async () => ({
      value: 'never',
    }));
    const rejected = expect(call).rejects.toThrow();
    cancelled.abort(new Error('client disconnected'));
    await rejected;
    expect(attempts.markDispatch).toHaveBeenCalledTimes(2);
    expect(runtime.queued).toBe(0);
    gate.resolve({ value: 'done' });
    await Promise.all(active);
    await runtime.drain();
  });

  it('round-robins merchants before draining one merchant backlog and ages management', async () => {
    const attempts = memoryAttempts();
    const runtime = new ModelRuntime(attempts, 1);
    const first = deferred<{ value: string }>();
    const order: string[] = [];
    const jobs = [runtime.dispatch(context('A'), signal(), () => first.promise)];
    for (const [merchant, operation, label] of [
      ['A', 'preview', 'A1'],
      ['A', 'consumer', 'A2'],
      ['A', 'writing', 'write'],
      ['A', 'consumer', 'A3'],
      ['A', 'consumer', 'A4'],
      ['B', 'preview', 'B'],
      ['C', 'preview', 'C'],
    ] as const)
      jobs.push(
        runtime.dispatch(context(merchant, operation), signal(), async () => {
          order.push(label);
          return { value: label };
        }),
      );
    first.resolve({ value: 'first' });
    await Promise.all(jobs);
    expect(order.slice(0, 2)).toEqual(['B', 'C']);
    expect(order.indexOf('write')).toBeLessThan(order.indexOf('A4'));
    await runtime.drain();
  });

  it('bounds the waiting queue and rejects new admission while draining', async () => {
    const runtime = new ModelRuntime(memoryAttempts(), 1, 1);
    const gate = deferred<{ value: string }>();
    const active = runtime.dispatch(context('A'), signal(), () => gate.promise);
    await vi.waitFor(() => expect(runtime.active).toBe(1));
    const waiting = runtime.dispatch(context('B'), signal(), async () => ({ value: 'B' }));
    await expect(
      runtime.dispatch(context('C'), signal(), async () => ({ value: 'C' })),
    ).rejects.toBeInstanceOf(ModelCapacityError);
    const rejected = expect(waiting).rejects.toBeInstanceOf(ModelCapacityError);
    runtime.stopAdmission();
    await rejected;
    await expect(
      runtime.dispatch(context('D'), signal(), async () => ({ value: 'D' })),
    ).rejects.toBeInstanceOf(ModelCapacityError);
    gate.resolve({ value: 'A' });
    await active;
    await runtime.drain();
  });

  it('ages one merchant management even when another merchant keeps taking management grants', async () => {
    const runtime = new ModelRuntime(memoryAttempts(), 1);
    const first = deferred<{ value: string }>();
    const order: string[] = [];
    const jobs = [runtime.dispatch(context('A'), signal(), () => first.promise)];
    for (let index = 0; index < 8; index += 1) {
      jobs.push(
        runtime.dispatch(context('A'), signal(), async () => {
          order.push(`A${index}`);
          return { value: 'answer' };
        }),
      );
      jobs.push(
        runtime.dispatch(context('B', 'organize'), signal(), async () => {
          order.push(`B${index}`);
          return { value: 'organized' };
        }),
      );
    }
    jobs.push(
      runtime.dispatch(context('A', 'writing'), signal(), async () => {
        order.push('A-writing');
        return { value: 'written' };
      }),
    );
    first.resolve({ value: 'first' });
    await Promise.all(jobs);
    expect(order.indexOf('A-writing')).toBeLessThan(order.indexOf('A3'));
    await runtime.drain();
  });

  it('never calls the supplier when the dispatch receipt commit response is lost', async () => {
    const attempts = memoryAttempts();
    attempts.markDispatch.mockImplementation(async () => {
      attempts.receipts.set('unconfirmed-commit', 'dispatched');
      throw Object.assign(new Error('commit response lost'), { code: 'MODEL_DISPATCH_UNKNOWN' });
    });
    const runtime = new ModelRuntime(attempts);
    const call = vi.fn(async () => ({ value: 'never' }));
    await expect(runtime.dispatch(context('A'), signal(), call)).rejects.toBeInstanceOf(
      ModelUnknownOutcomeError,
    );
    expect(call).not.toHaveBeenCalled();
    expect(attempts.recordOutcome).not.toHaveBeenCalled();
    expect(await attempts.unknownRiskCount()).toBe(1);
    await runtime.drain();
  });

  it.each([false, true])(
    'does not fetch after an abort during reservation, with lost non-dispatch receipt %s',
    async (lostOutcome) => {
      const attempts = memoryAttempts();
      const abort = new AbortController();
      attempts.markDispatch.mockImplementation(async () => {
        attempts.receipts.set('reserved', 'dispatched');
        abort.abort(new Error('cancelled during reservation'));
        return { attemptId: 'reserved' };
      });
      if (lostOutcome) attempts.recordOutcome.mockRejectedValue(new Error('receipt response lost'));
      const runtime = new ModelRuntime(attempts);
      const call = vi.fn(async () => ({ value: 'never' }));
      const dispatched = runtime.dispatch(context('A'), abort.signal, call);
      if (lostOutcome) await expect(dispatched).rejects.toBeInstanceOf(ModelUnknownOutcomeError);
      else await expect(dispatched).rejects.toThrow('cancelled during reservation');
      expect(call).not.toHaveBeenCalled();
      expect(attempts.recordOutcome).toHaveBeenCalledWith(
        'reserved',
        'not_dispatched',
        expect.any(Date),
      );
      expect(attempts.receipts.get('reserved')).toBe(lostOutcome ? 'dispatched' : 'not_dispatched');
      await runtime.drain();
    },
  );

  it('drains accepted work without aborting it, and aborts an over-budget call as unknown', async () => {
    const attempts = memoryAttempts();
    const runtime = new ModelRuntime(attempts);
    const gate = deferred<{ value: string }>();
    let dispatchSignal: AbortSignal | undefined;
    const call = runtime.dispatch(context('A'), signal(), async (value) => {
      dispatchSignal = value;
      return gate.promise;
    });
    await vi.waitFor(() => expect(runtime.active).toBe(1));
    const drain = runtime.drain(1000);
    expect(dispatchSignal?.aborted).toBe(false);
    gate.resolve({ value: 'accepted' });
    await expect(call).resolves.toBe('accepted');
    await expect(drain).resolves.toBe('drained');
    const restarted = new ModelRuntime(attempts);
    const stuck = restarted.dispatch(context('B'), signal(), () => new Promise(() => undefined));
    const rejection = expect(stuck).rejects.toBeInstanceOf(ModelUnknownOutcomeError);
    await vi.waitFor(() => expect(restarted.active).toBe(1));
    await expect(restarted.drain(5)).resolves.toBe('aborted');
    await rejection;
    expect([...attempts.receipts.values()]).toEqual(['succeeded', 'unknown']);
  });

  it('persists unknown risk across executor restarts, counting an active receipt in the limit', async () => {
    const attempts = memoryAttempts();
    attempts.receipts.set('previous-process', 'unknown');
    const runtime = new ModelRuntime(attempts);
    const gate = deferred<{ value: string }>();
    const active = runtime.dispatch(context('A'), signal(), () => gate.promise);
    await vi.waitFor(() => expect(runtime.active).toBe(1));
    const waiting = runtime.dispatch(context('B'), signal(), async () => ({ value: 'B' }));
    await vi.waitFor(() => expect(runtime.queued).toBe(1));
    expect(attempts.markDispatch).toHaveBeenCalledOnce();
    gate.resolve({ value: 'A' });
    await active;
    await expect(waiting).resolves.toBe('B');
    await expect(
      runtime.dispatch(context('C'), signal(), async () => ({ value: 'C' })),
    ).resolves.toBe('C');
    await runtime.drain();
    attempts.receipts.set('other-unknown', 'dispatched');
    const restarted = new ModelRuntime(attempts);
    await expect(restarted.probeReadiness()).resolves.toBe(false);
    const cancelled = new AbortController();
    const held = restarted.dispatch(context('D'), cancelled.signal, async () => ({ value: 'D' }));
    const rejected = expect(held).rejects.toThrow('cancelled while risk brake is closed');
    await vi.waitFor(() => expect(restarted.queued).toBe(1));
    cancelled.abort(new Error('cancelled while risk brake is closed'));
    await rejected;
    await restarted.drain();
  });

  it('binds a consumer permit to its merchant, claim generation and one dispatch', async () => {
    const attempts = memoryAttempts();
    const runtime = new ModelRuntime(attempts);
    const claim = { jobId: 'job', claimGeneration: 'g1', merchantId: 'A' } as NonNullable<
      ModelContext['claim']
    >;
    await runtime.enqueueConsumer('A', signal(), async (permit) => {
      runtime.bindClaim(permit, claim);
      const call = async () => ({ value: 'answer' });
      await expect(
        runtime.dispatch({ merchantId: 'B', operation: 'consumer', claim, permit }, signal(), call),
      ).rejects.toBeInstanceOf(ModelCapacityError);
      await expect(
        runtime.dispatch(
          {
            merchantId: 'A',
            operation: 'consumer',
            claim: { ...claim, claimGeneration: 'g2' },
            permit,
          },
          signal(),
          call,
        ),
      ).rejects.toBeInstanceOf(ModelCapacityError);
      const first = runtime.dispatch(
        { merchantId: 'A', operation: 'consumer', claim, permit },
        signal(),
        call,
      );
      await expect(
        runtime.dispatch({ merchantId: 'A', operation: 'consumer', claim, permit }, signal(), call),
      ).rejects.toBeInstanceOf(ModelCapacityError);
      await first;
    });
    expect(attempts.markDispatch).toHaveBeenCalledTimes(1);
    await runtime.drain();
  });

  it('does not count a locally unknown call as healthy active load while outcome persistence hangs', async () => {
    const attempts = memoryAttempts();
    attempts.receipts.set('previous-unknown', 'unknown');
    const persistence = deferred<void>();
    const reached = deferred<void>();
    attempts.recordOutcome.mockImplementation(async (id, outcome) => {
      reached.resolve();
      await persistence.promise;
      attempts.receipts.set(id, outcome);
    });
    const runtime = new ModelRuntime(attempts);
    const call = runtime.dispatch(context('A'), signal(), async () => {
      throw new Error('supplier connection reset');
    });
    const rejected = expect(call).rejects.toBeInstanceOf(ModelUnknownOutcomeError);
    await reached.promise;
    try {
      expect(runtime.active).toBe(0);
      await expect(runtime.probeReadiness()).resolves.toBe(false);
    } finally {
      persistence.resolve();
      await rejected;
      await runtime.drain();
    }
  });
});
