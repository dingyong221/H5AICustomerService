import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { workerRuntimeSnapshotSchema, type WorkerRuntimeSnapshot } from '@h5cs/contracts';
export type RuntimeObservationDependencies = {
  runtime: {
    readonly active: number;
    readonly queued: number;
    readonly accepting: boolean;
    readonly capacity: number;
  };
  controlEnabled: boolean;
  globalState: () => Promise<'active' | 'manually_stopped'>;
  risk: () => Promise<number>;
};
export type RuntimeObservationService = {
  authorized: (value: unknown) => boolean;
  snapshot: () => Promise<WorkerRuntimeSnapshot>;
};
export function createRuntimeObservation(
  environment: NodeJS.ProcessEnv,
  dependencies: RuntimeObservationDependencies,
): RuntimeObservationService | null {
  const path = environment['WORKER_OBSERVATION_TOKEN_FILE'];
  if (!path || !isAbsolute(path)) return null;
  let token: Buffer;
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 128 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      return null;
    const value = readFileSync(path, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
    token = Buffer.from(value);
  } catch {
    return null;
  }
  const startedAt = new Date().toISOString(),
    instanceId = `worker_${randomBytes(16).toString('hex')}`;
  return {
    authorized(value) {
      return (
        typeof value === 'string' &&
        /^[A-Za-z0-9_-]{43}$/u.test(value) &&
        timingSafeEqual(token, Buffer.from(value))
      );
    },
    async snapshot() {
      let globalControlState: 'active' | 'manually_stopped' | null = null,
        controlSchemaReady = !dependencies.controlEnabled,
        unresolvedRiskCount: number | null = null,
        riskProbeAt: string | null = null;
      if (dependencies.controlEnabled)
        try {
          globalControlState = await dependencies.globalState();
          controlSchemaReady = true;
        } catch {}
      try {
        unresolvedRiskCount = await dependencies.risk();
        riskProbeAt = new Date().toISOString();
      } catch {}
      return workerRuntimeSnapshotSchema.parse({
        schemaVersion: 1,
        instanceId,
        startedAt,
        observedAt: new Date().toISOString(),
        localModelActive: dependencies.runtime.active,
        localQueued: dependencies.runtime.queued,
        accepting: dependencies.runtime.accepting,
        capacity: dependencies.runtime.capacity,
        managementCapacity: 1,
        controlEnabled: dependencies.controlEnabled,
        controlSchemaReady,
        globalControlState,
        unresolvedRiskCount,
        riskProbeAt,
      });
    },
  };
}
