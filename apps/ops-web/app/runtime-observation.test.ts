import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), read: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => ({ open: mocks.open }));
import { readWorkerObservation, workerObservationUrl } from './runtime-observation';
const environment = {
  WORKER_OBSERVATION_TOKEN_FILE: 'F:/synthetic/token',
  WORKER_OBSERVATION_URL: 'http://worker:3011/internal/runtime-snapshot',
};
const token = 'A'.repeat(43);
const snapshot = {
  schemaVersion: 1,
  instanceId: `worker_${'a'.repeat(32)}`,
  startedAt: '2026-11-17T00:00:00Z',
  observedAt: '2026-11-17T00:01:00Z',
  localModelActive: 1,
  localQueued: 0,
  accepting: true,
  capacity: 2,
  managementCapacity: 1,
  controlEnabled: true,
  controlSchemaReady: true,
  globalControlState: 'manually_stopped',
  unresolvedRiskCount: null,
  riskProbeAt: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue({ close: mocks.close, stat: mocks.stat, readFile: mocks.read });
  mocks.stat.mockResolvedValue({ isFile: () => true, size: 44 });
  mocks.read.mockResolvedValue(`${token}\n`);
});
describe('independent server-side Worker observation', () => {
  it.each([
    'https://evil.test/internal/runtime-snapshot',
    'http://worker:3011/internal/runtime-snapshot?token=x',
    'http://user:pass@worker:3011/internal/runtime-snapshot',
    'http://worker:3011/other',
    'http://169.254.169.254:3011/internal/runtime-snapshot',
  ])('rejects unsafe URL %s before token access', async (url) => {
    const fetchImpl = vi.fn();
    expect(workerObservationUrl(url)).toBeNull();
    expect(
      (await readWorkerObservation({ ...environment, WORKER_OBSERVATION_URL: url }, fetchImpl))
        .snapshot,
    ).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('uses only the local token file and no-store bounded internal GET, returning only strict metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(snapshot));
    const result = await readWorkerObservation(environment, fetchImpl);
    expect(result.snapshot).toEqual(snapshot);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      signal: expect.any(AbortSignal),
      headers: { 'X-H5CS-Observation-Token': token },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it.each([
    { ...snapshot, extra: 'payload' },
    { ...snapshot, localModelActive: -1 },
    { ...snapshot, observedAt: 'not-a-time' },
    { ...snapshot, globalControlState: 'fake' },
  ])('rejects noncontract snapshot instead of showing zeros %j', async (payload) => {
    const result = await readWorkerObservation(
      environment,
      vi.fn().mockResolvedValue(Response.json(payload)),
    );
    expect(result.snapshot).toBeNull();
    expect(result.error).toContain('不能据此判断');
  });
  it('limits actual streamed body independently of declared length', async () => {
    const result = await readWorkerObservation(
      environment,
      vi
        .fn()
        .mockResolvedValue(
          new Response('x'.repeat(16385), { headers: { 'content-type': 'application/json' } }),
        ),
    );
    expect(result.snapshot).toBeNull();
  });
  it('never forwards token or fetch diagnostics on failure', async () => {
    const result = await readWorkerObservation(
      environment,
      vi.fn().mockRejectedValue(new Error(token)),
    );
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.snapshot).toBeNull();
  });
  it('does not fetch when the file is absent, oversized, or malformed', async () => {
    const fetchImpl = vi.fn();
    mocks.stat.mockResolvedValue({ isFile: () => true, size: 1000 });
    expect((await readWorkerObservation(environment, fetchImpl)).snapshot).toBeNull();
    mocks.stat.mockResolvedValue({ isFile: () => true, size: 4 });
    mocks.read.mockResolvedValue('bad');
    expect((await readWorkerObservation(environment, fetchImpl)).snapshot).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
