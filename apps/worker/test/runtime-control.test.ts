import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeExecutionBlockedError } from '@h5cs/database';
import { workerRuntimeSnapshotSchema } from '@h5cs/contracts';
import { ModelRuntime, ModelRuntimePausedError } from '../src/model-runtime.js';
import { createRuntimeObservation } from '../src/runtime-observation.js';
import { createHealthServer } from '../src/health-server.js';
import { WorkerHealth } from '../src/worker-health.js';
describe('runtime controls and independent observation', () => {
  it.each(['preview', 'writing', 'organize'] as const)(
    'blocks %s before provider execution or result accounting',
    async (operation) => {
      const call = vi.fn(),
        recordOutcome = vi.fn(),
        runtime = new ModelRuntime({
          unknownRiskCount: async () => 0,
          markDispatch: async () => {
            throw new RuntimeExecutionBlockedError();
          },
          recordOutcome,
        });
      await expect(
        runtime.dispatch(
          { merchantId: 'a'.repeat(32), operation },
          new AbortController().signal,
          call,
        ),
      ).rejects.toBeInstanceOf(ModelRuntimePausedError);
      expect(call).not.toHaveBeenCalled();
      expect(recordOutcome).not.toHaveBeenCalled();
      expect(runtime.active).toBe(0);
    },
  );
  it('strict snapshot rejects negative load, unknown keys and invalid dates', () => {
    const x = {
      schemaVersion: 1,
      instanceId: 'worker_' + 'a'.repeat(32),
      startedAt: new Date().toISOString(),
      observedAt: new Date().toISOString(),
      localModelActive: 0,
      localQueued: 0,
      accepting: true,
      capacity: 2,
      managementCapacity: 1,
      controlEnabled: true,
      controlSchemaReady: true,
      globalControlState: 'manually_stopped',
      unresolvedRiskCount: 0,
      riskProbeAt: null,
    };
    expect(workerRuntimeSnapshotSchema.safeParse(x).success).toBe(true);
    for (const patch of [
      { localModelActive: -1 },
      { payload: 'secret' },
      { observedAt: 'bad' },
      { globalControlState: 'resume' },
    ])
      expect(workerRuntimeSnapshotSchema.safeParse({ ...x, ...patch }).success).toBe(false);
  });
  it('existing HTTP port protects snapshot with independent read-only token and keeps livez healthy when manually stopped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'h5cs-observation-')),
      path = join(dir, 'token'),
      token = 'a'.repeat(43);
    await writeFile(path, token, { mode: 0o600 });
    const observation = createRuntimeObservation(
      { WORKER_OBSERVATION_TOKEN_FILE: path },
      {
        runtime: { active: 1, queued: 2, accepting: true, capacity: 2 },
        controlEnabled: true,
        globalState: async () => 'manually_stopped',
        risk: async () => 1,
      },
    );
    expect(observation).not.toBeNull();
    const server = createHealthServer(new WorkerHealth(), null, 20000, observation);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address() as { port: number },
      url = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(url + '/internal/runtime-snapshot')).status).toBe(404);
      expect(
        (
          await fetch(url + '/internal/runtime-snapshot', {
            headers: { 'x-h5cs-preview-token': token },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(url + '/internal/runtime-snapshot', {
            headers: { 'x-h5cs-observation-token': 'b'.repeat(43) },
          })
        ).status,
      ).toBe(404);
      const response = await fetch(url + '/internal/runtime-snapshot', {
          headers: { 'x-h5cs-observation-token': token },
        }),
        snapshot = await response.json();
      expect(response.status).toBe(200);
      expect(workerRuntimeSnapshotSchema.parse(snapshot).globalControlState).toBe(
        'manually_stopped',
      );
      expect(JSON.stringify(snapshot)).not.toContain(token);
      expect((await fetch(url + '/livez')).status).toBe(200);
      expect(
        (
          await fetch(url + '/internal/runtime-snapshot', {
            method: 'POST',
            headers: { 'x-h5cs-observation-token': token },
          })
        ).status,
      ).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r, e) => server.close((err) => (err ? e(err) : r())));
      await unlink(path);
      await rmdir(dir);
    }
  });
  it('missing configuration disables endpoint; failed control/risk reads remain unknown', async () => {
    const dep = {
      runtime: { active: 0, queued: 0, accepting: false, capacity: 2 },
      controlEnabled: true,
      globalState: async () => {
        throw Error('unavailable');
      },
      risk: async () => {
        throw Error('unavailable');
      },
    };
    expect(createRuntimeObservation({}, dep)).toBeNull();
    expect(
      createRuntimeObservation({ WORKER_OBSERVATION_TOKEN_FILE: 'https://host/secret' }, dep),
    ).toBeNull();
    const dir = await mkdtemp(join(tmpdir(), 'h5cs-observation-')),
      path = join(dir, 'token');
    await writeFile(path, 'a'.repeat(43), { mode: 0o600 });
    try {
      const snapshot = await createRuntimeObservation(
        { WORKER_OBSERVATION_TOKEN_FILE: path },
        dep,
      )!.snapshot();
      expect(snapshot.globalControlState).toBeNull();
      expect(snapshot.controlSchemaReady).toBe(false);
      expect(snapshot.unresolvedRiskCount).toBeNull();
      expect(snapshot.accepting).toBe(false);
    } finally {
      await unlink(path);
      await rmdir(dir);
    }
  });
});
