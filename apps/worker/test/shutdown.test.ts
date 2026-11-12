import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationTurnClaim } from '@h5cs/database';
import { ChatCompletionsGenerator } from '../src/chat-completions-generator.js';
import {
  ConversationTurnProcessor,
  type ConversationTurnStore,
} from '../src/conversation-turn-processor.js';
import { ModelRuntime, type ModelAttemptStore } from '../src/model-runtime.js';
import { PreviewService } from '../src/preview-service.js';
import { startWorkerApplication } from '../src/worker-application.js';
import { WorkerHealth } from '../src/worker-health.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};
const response = () =>
  Response.json({
    object: 'chat.completion',
    id: 'synthetic-request',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '29元每条。' } },
    ],
  });
const facts = {
  assistantName: '合成商家',
  industry: '合成行业',
  businessScope: '毛巾',
  materialsSummary: '毛巾',
  pricingSummary: '29元每条',
  promotionSummary: '暂无优惠',
  insufficientInfoMessage: '请向商家核实',
};
const claim: ConversationTurnClaim = {
  jobId: '11'.repeat(16),
  merchantId: '22'.repeat(16),
  assistantId: '33'.repeat(16),
  sessionId: '44'.repeat(16),
  releaseId: '55'.repeat(16),
  turnId: '66'.repeat(16),
  visitorMessageId: '77'.repeat(16),
  leaseOwner: 'synthetic-worker',
  claimGeneration: '1',
  leaseUntil: new Date(Date.now() + 120_000),
  payloadVersion: 0,
  question: '毛巾多少钱',
  context: [],
  facts: { ...facts, displayName: facts.assistantName },
};
const config = {
  endpoint: 'http://127.0.0.1:9000/chat/completions',
  model: 'local-stop-test',
  apiKey: 'local-fixture-synthetic-only',
};

function fixture(fault?: 'probe' | 'claim' | 'markDispatch' | 'recordOutcome', consumer = true) {
  const held = deferred<void>();
  const reached = deferred<void>();
  const health = new WorkerHealth();
  vi.spyOn(health, 'databaseAvailable').mockReturnValue(true);
  vi.spyOn(health, 'probeDatabase').mockImplementation(async () => {
    if (fault === 'probe') {
      reached.resolve();
      await held.promise;
    }
  });
  const outcomes = new Map<string, string>();
  const attempts: ModelAttemptStore = {
    unknownRiskCount: async () =>
      [...outcomes.values()].filter((state) => ['dispatched', 'unknown'].includes(state)).length,
    markDispatch: vi.fn(async () => {
      if (fault === 'markDispatch') {
        reached.resolve();
        await held.promise;
      }
      outcomes.set('attempt', 'dispatched');
      return { attemptId: 'attempt' };
    }),
    recordOutcome: vi.fn(async (_id, outcome) => {
      if (fault === 'recordOutcome') {
        reached.resolve();
        await held.promise;
      }
      outcomes.set('attempt', outcome);
    }),
  };
  const runtime = new ModelRuntime(attempts);
  let runnable = consumer;
  const complete = vi.fn<ConversationTurnStore['complete']>(async () => 'applied');
  const fail = vi.fn<ConversationTurnStore['fail']>(async () => 'applied');
  const releaseBeforeDispatch = vi.fn<ConversationTurnStore['releaseBeforeDispatch']>(async () =>
    !outcomes.size || outcomes.get('attempt') === 'not_dispatched' ? 'applied' : 'stale',
  );
  const claimNext = vi.fn<ConversationTurnStore['claimNext']>(async () => {
    if (!runnable) return null;
    runnable = false;
    if (fault === 'claim') {
      reached.resolve();
      await held.promise;
    }
    return claim;
  });
  const store: ConversationTurnStore = {
    claimNext,
    complete,
    fail,
    releaseBeforeDispatch,
    listRunnableMerchantHeads: async () =>
      runnable ? [{ merchantId: claim.merchantId, oldestReadyAt: new Date(0) }] : [],
    reconcile: async () => ({
      state: 'processing',
      currentGeneration: claim.claimGeneration,
      modelOutcome: outcomes.get('attempt') === 'unknown' ? 'unknown' : 'succeeded',
    }),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  const assertAccess = vi.fn(async () => undefined);
  const generator = new ChatCompletionsGenerator(
    config,
    fetchImpl,
    undefined,
    assertAccess,
    runtime,
  );
  const processor = new ConversationTurnProcessor(store, generator, 'synthetic-worker');
  const token = randomBytes(32).toString('base64url');
  const preview = new PreviewService(token, generator);
  return {
    held,
    reached,
    health,
    runtime,
    processor,
    preview,
    token,
    outcomes,
    attempts,
    fetchImpl,
    assertAccess,
    claimNext,
    complete,
    fail,
    releaseBeforeDispatch,
  };
}

async function settleBefore(promise: Promise<void>, timeoutMs = 150): Promise<'settled' | 'hung'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => 'settled' as const),
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(() => resolve('hung'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('bounded application shutdown', () => {
  it.each(['probe', 'claim', 'markDispatch', 'recordOutcome'] as const)(
    'stops within the shared budget when %s never responds',
    async (fault) => {
      const value = fixture(fault);
      const application = await startWorkerApplication({
        health: value.health,
        dispatch: { configured: true, processor: value.processor, runtime: value.runtime },
        preview: null,
        host: '127.0.0.1',
        port: 0,
        drainMs: 5,
        finalizationMs: 5,
      });
      await value.reached.promise;
      const stop = application.stop();
      try {
        expect(await settleBefore(stop)).toBe('settled');
        expect(value.runtime.accepting).toBe(false);
        expect(application.server.listening).toBe(false);
        expect(value.complete).not.toHaveBeenCalled();
        expect(value.fetchImpl).toHaveBeenCalledTimes(fault === 'recordOutcome' ? 1 : 0);
      } finally {
        value.held.resolve();
        await stop;
        await value.runtime.drain(100, 5);
      }
      expect(value.complete).not.toHaveBeenCalled();
      expect(value.fetchImpl).toHaveBeenCalledTimes(fault === 'recordOutcome' ? 1 : 0);
      if (fault === 'claim' || fault === 'markDispatch')
        expect(value.releaseBeforeDispatch).toHaveBeenCalled();
    },
  );

  it('closes in-flight HTTP after the finalization budget even when outcome persistence hangs', async () => {
    const value = fixture('recordOutcome', false);
    const application = await startWorkerApplication({
      health: value.health,
      dispatch: { configured: true, processor: value.processor, runtime: value.runtime },
      preview: value.preview,
      host: '127.0.0.1',
      port: 0,
      drainMs: 5,
      finalizationMs: 5,
    });
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('missing listen address');
    const request = fetch(`http://127.0.0.1:${address.port}/internal/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-h5cs-preview-token': value.token },
      body: JSON.stringify({ merchantId: claim.merchantId, facts, question: '毛巾多少钱' }),
    }).then(
      (result) => result.status,
      () => 0,
    );
    await value.reached.promise;
    const stop = application.stop();
    try {
      expect(await settleBefore(stop)).toBe('settled');
      expect(await request).toBe(0);
      expect(value.outcomes.get('attempt')).toBe('dispatched');
    } finally {
      value.held.resolve();
      await stop;
      await value.runtime.drain(100, 5);
    }
    expect(value.fetchImpl).toHaveBeenCalledOnce();
  });

  it('finishes accepted HTTP successfully during normal drain before closing', async () => {
    const value = fixture(undefined, false);
    const supplier = deferred<Response>();
    value.fetchImpl.mockImplementation(() => supplier.promise);
    const application = await startWorkerApplication({
      health: value.health,
      dispatch: { configured: true, processor: value.processor, runtime: value.runtime },
      preview: value.preview,
      host: '127.0.0.1',
      port: 0,
      drainMs: 1_000,
      finalizationMs: 5,
    });
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('missing listen address');
    const request = fetch(`http://127.0.0.1:${address.port}/internal/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-h5cs-preview-token': value.token },
      body: JSON.stringify({ merchantId: claim.merchantId, facts, question: '毛巾多少钱' }),
    });
    await vi.waitFor(() => expect(value.fetchImpl).toHaveBeenCalledOnce());
    const stop = application.stop();
    supplier.resolve(response());
    expect((await request).status).toBe(200);
    await stop;
    expect(value.outcomes.get('attempt')).toBe('succeeded');
    expect(application.server.listening).toBe(false);
  });
});

describe('synchronous HTTP admission deadline', () => {
  it('ends an incomplete HTTP request body at the total deadline without any model admission', async () => {
    const value = fixture(undefined, false);
    const application = await startWorkerApplication({
      health: value.health,
      dispatch: { configured: true, processor: value.processor, runtime: value.runtime },
      preview: value.preview,
      host: '127.0.0.1',
      port: 0,
      drainMs: 100,
      finalizationMs: 5,
      httpTimeoutMs: 50,
    });
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('missing listen address');
    const request = httpRequest(`http://127.0.0.1:${address.port}/internal/preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '200',
        'x-h5cs-preview-token': value.token,
      },
    });
    const ended = new Promise<number>((resolve) => {
      request.on('error', () => resolve(0));
      request.on('response', (result) => {
        result.resume();
        resolve(result.statusCode ?? 0);
      });
    });
    request.write('{"merchantId":');
    try {
      expect(
        await settleBefore(
          ended.then(() => undefined),
          500,
        ),
      ).toBe('settled');
      expect(await ended).toBe(0);
      expect(value.attempts.markDispatch).not.toHaveBeenCalled();
      expect(value.fetchImpl).not.toHaveBeenCalled();
    } finally {
      request.destroy();
      await application.stop();
    }
  });

  it.each(['eligibility', 'outcome persistence'] as const)(
    'bounds total HTTP time even when %s never responds',
    async (stage) => {
      const value = fixture(stage === 'outcome persistence' ? 'recordOutcome' : undefined, false);
      if (stage === 'eligibility')
        value.assertAccess.mockImplementation(async () => {
          value.reached.resolve();
          await value.held.promise;
          return undefined;
        });
      const application = await startWorkerApplication({
        health: value.health,
        dispatch: { configured: true, processor: value.processor, runtime: value.runtime },
        preview: value.preview,
        host: '127.0.0.1',
        port: 0,
        drainMs: 5,
        finalizationMs: 5,
        httpTimeoutMs: 50,
      });
      const address = application.server.address();
      if (!address || typeof address === 'string') throw new Error('missing listen address');
      const request = fetch(`http://127.0.0.1:${address.port}/internal/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-h5cs-preview-token': value.token },
        body: JSON.stringify({
          merchantId: claim.merchantId,
          facts,
          question: stage === 'eligibility' ? '转人工' : '毛巾多少钱',
        }),
      }).then(
        (result) => result.status,
        () => 0,
      );
      await value.reached.promise;
      try {
        expect(await settleBefore(request.then(() => undefined))).toBe('settled');
        expect(await request).toBe(503);
        expect(value.fetchImpl).toHaveBeenCalledTimes(stage === 'eligibility' ? 0 : 1);
        if (stage === 'eligibility') expect(value.attempts.markDispatch).not.toHaveBeenCalled();
        else expect(value.outcomes.get('attempt')).toBe('dispatched');
      } finally {
        value.held.resolve();
        await request;
        await application.stop();
      }
      expect(value.fetchImpl).toHaveBeenCalledTimes(stage === 'eligibility' ? 0 : 1);
    },
  );

  it.each(['deadline', 'disconnect'] as const)(
    'cancels a queued %s without dispatching or reserving a fee',
    async (cause) => {
      const value = fixture(undefined, false);
      const occupied = deferred<void>();
      const active = [0, 1].map(() =>
        value.runtime.enqueueConsumer('busy', new AbortController().signal, () => occupied.promise),
      );
      const application = await startWorkerApplication({
        health: value.health,
        dispatch: { configured: true, processor: value.processor, runtime: value.runtime },
        preview: value.preview,
        host: '127.0.0.1',
        port: 0,
        drainMs: 100,
        finalizationMs: 5,
        httpTimeoutMs: 100,
      });
      const address = application.server.address();
      if (!address || typeof address === 'string') throw new Error('missing listen address');
      const disconnected = new AbortController();
      const request = fetch(`http://127.0.0.1:${address.port}/internal/preview`, {
        method: 'POST',
        signal: disconnected.signal,
        headers: { 'content-type': 'application/json', 'x-h5cs-preview-token': value.token },
        body: JSON.stringify({ merchantId: claim.merchantId, facts, question: '毛巾多少钱' }),
      }).then(
        (result) => result.status,
        () => 0,
      );
      try {
        await vi.waitFor(() => expect(value.runtime.queued).toBe(1), { interval: 1 });
        if (cause === 'disconnect') disconnected.abort();
        expect(await request).toBe(cause === 'disconnect' ? 0 : 503);
        await vi.waitFor(() => expect(value.runtime.queued).toBe(0), { interval: 1 });
        expect(value.attempts.markDispatch).not.toHaveBeenCalled();
        expect(value.fetchImpl).not.toHaveBeenCalled();
        expect(value.outcomes.size).toBe(0);
      } finally {
        occupied.resolve();
        await Promise.all(active);
        await application.stop();
      }
    },
  );

  it('records an already dispatched HTTP deadline as unknown and never resends the supplier call', async () => {
    const value = fixture(undefined, false);
    const supplier = deferred<Response>();
    value.fetchImpl.mockImplementation(() => supplier.promise);
    const application = await startWorkerApplication({
      health: value.health,
      dispatch: { configured: true, processor: value.processor, runtime: value.runtime },
      preview: value.preview,
      host: '127.0.0.1',
      port: 0,
      drainMs: 100,
      finalizationMs: 5,
      httpTimeoutMs: 100,
    });
    const address = application.server.address();
    if (!address || typeof address === 'string') throw new Error('missing listen address');
    const result = await fetch(`http://127.0.0.1:${address.port}/internal/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-h5cs-preview-token': value.token },
      body: JSON.stringify({ merchantId: claim.merchantId, facts, question: '毛巾多少钱' }),
    });
    expect(result.status).toBe(503);
    expect(value.outcomes.get('attempt')).toBe('unknown');
    expect(value.attempts.markDispatch).toHaveBeenCalledOnce();
    expect(value.fetchImpl).toHaveBeenCalledOnce();
    await application.stop();
    supplier.resolve(response());
    await value.runtime.drain(100, 5);
    expect(value.outcomes.get('attempt')).toBe('unknown');
  });
});
