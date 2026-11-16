// Server module: imported only by the authenticated server-rendered runtime panel.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { workerRuntimeSnapshotSchema, type WorkerRuntimeSnapshot } from '@h5cs/contracts';

export type WorkerObservation =
  { snapshot: WorkerRuntimeSnapshot; error: null } | { snapshot: null; error: string };
export function workerObservationUrl(
  raw = 'http://worker:3011/internal/runtime-snapshot',
): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' &&
      ['worker', '127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.port === '3011' &&
      url.pathname === '/internal/runtime-snapshot' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}
export async function readWorkerObservation(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerObservation> {
  const failed = (): WorkerObservation => ({
    snapshot: null,
    error: 'Worker 独立观测暂不可用；不能据此判断活动调用或风险为零。',
  });
  const url = workerObservationUrl(environment['WORKER_OBSERVATION_URL']);
  const path = environment['WORKER_OBSERVATION_TOKEN_FILE'];
  if (!url || !path || !isAbsolute(path) || path.startsWith('\\\\')) return failed();
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let token: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 128) return failed();
      token = (await file.readFile({ encoding: 'utf8' })).trim();
    } finally {
      await file.close();
    }
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return failed();
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(3000),
      headers: { Accept: 'application/json', 'X-H5CS-Observation-Token': token },
    });
    if (
      !response.ok ||
      !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
      !response.body
    )
      return failed();
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/u.test(declared) || Number(declared) > 16384)) {
      await response.body.cancel();
      return failed();
    }
    const reader = response.body.getReader();
    const buffer = new Uint8Array(16384);
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > buffer.byteLength) {
          await reader.cancel();
          return failed();
        }
        buffer.set(chunk.value, size - chunk.value.byteLength);
      }
    } finally {
      reader.releaseLock();
    }
    const parsed = workerRuntimeSnapshotSchema.safeParse(
      JSON.parse(new TextDecoder().decode(buffer.subarray(0, size))) as unknown,
    );
    return parsed.success ? { snapshot: parsed.data, error: null } : failed();
  } catch {
    return failed();
  }
}
