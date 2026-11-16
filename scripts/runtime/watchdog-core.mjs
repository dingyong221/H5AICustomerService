import { open } from 'node:fs/promises';

const BODY_LIMIT = 16 * 1024;
const TOKEN_HEADER = 'X-H5CS-Observation-Token';
export function internalSnapshotUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost', 'worker'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/internal/runtime-snapshot'
  )
    throw Error('Observation requires the fixed loopback or internal Worker endpoint');
  return url;
}
export async function loadObservationToken(file) {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 512 || stat.size < 43)
      throw Error('Invalid observation token file');
    const data = Buffer.alloc(513);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > 512) throw Error('Invalid observation token file');
    const token = data.subarray(0, bytesRead).toString('utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw Error('Invalid observation token file');
    return token;
  } finally {
    await handle.close();
  }
}
export function evaluateSnapshot(
  snapshot,
  { now = Date.now(), maxAgeMs = 15000, queueWarning = 20 } = {},
) {
  const issues = [];
  const ageMs = now - Date.parse(snapshot.observedAt);
  if (!Number.isFinite(ageMs) || ageMs < -2000 || ageMs > maxAgeMs) issues.push('snapshot_stale');
  if (snapshot.controlEnabled && !snapshot.controlSchemaReady)
    issues.push('control_schema_unavailable');
  if (!snapshot.accepting) issues.push('process_draining');
  if (snapshot.globalControlState === 'manually_stopped') issues.push('global_manually_stopped');
  if (snapshot.controlEnabled && snapshot.globalControlState === null)
    issues.push('control_state_unavailable');
  if (snapshot.localQueued > queueWarning) issues.push('local_queue_warning');
  if (snapshot.unresolvedRiskCount === null) issues.push('risk_probe_unavailable');
  else if (snapshot.unresolvedRiskCount > 0) issues.push('unresolved_supplier_risk');
  const riskAge = snapshot.riskProbeAt === null ? NaN : now - Date.parse(snapshot.riskProbeAt);
  if (!Number.isFinite(riskAge) || riskAge < -2000 || riskAge > 60000)
    issues.push('risk_probe_stale');
  return {
    status: issues.length ? 'attention' : 'healthy',
    issues,
    ageMs,
    observedAt: snapshot.observedAt,
    source: 'worker_memory_and_database_probe',
    localModelActive: snapshot.localModelActive,
    localQueued: snapshot.localQueued,
    capacity: snapshot.capacity,
    accepting: snapshot.accepting,
    controlEnabled: snapshot.controlEnabled,
    controlSchemaReady: snapshot.controlSchemaReady,
    globalControlState: snapshot.globalControlState,
    unresolvedRiskCount: snapshot.unresolvedRiskCount,
    scope: 'one_worker_global_control_only',
    actionsExecuted: [],
  };
}
export async function inspectRuntime({
  url,
  tokenFile,
  parseSnapshot,
  timeoutMs = 3000,
  ...thresholds
}) {
  const target = internalSnapshotUrl(url);
  const token = await loadObservationToken(tokenFile);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: { [TOKEN_HEADER]: token, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw Error('Observation endpoint unavailable');
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
      throw Error('Invalid observation response');
    const reader = response.body?.getReader();
    if (!reader) throw Error('Empty observation response');
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > BODY_LIMIT) throw Error('Observation response too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const parsed = parseSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return evaluateSnapshot(parsed, thresholds);
  } finally {
    clearTimeout(timer);
  }
}
