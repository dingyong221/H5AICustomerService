export type TaskOutcome = {
  modelOutcome: string;
  result?: unknown;
  appliedRevision?: number | undefined;
};

export const unresolvedTaskOutcome = (task: TaskOutcome) =>
  task.modelOutcome === 'unknown' ||
  task.modelOutcome === 'dispatched' ||
  (task.modelOutcome === 'succeeded' && !task.result && !task.appliedRevision);

export function taskRequestId(prefix: 'organize' | 'authoring') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

// Browser storage never authorizes a task. Each read/write still uses the
// existing session and a server-side scope check. Callers validate stored shape.
export function readTaskReference<T>(key: string, parse: (value: unknown) => T): T | null {
  const raw = window.sessionStorage.getItem(key);
  return raw ? parse(JSON.parse(raw) as unknown) : null;
}

export function saveTaskReference(key: string | undefined, value: unknown | null) {
  if (!key) throw new Error('无法保存任务恢复信息，请刷新后重试。');
  if (value === null) window.sessionStorage.removeItem(key);
  else window.sessionStorage.setItem(key, JSON.stringify(value));
}

// GET intentionally sends neither Origin nor the write CSRF token. The browser
// supplies same-origin session cookies; only explicit writes carry CSRF.
export function fetchTask(url: string, write?: { body: unknown; csrf: string }) {
  return fetch(url, {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(write ? 30000 : 15000),
    ...(write
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-h5cs-csrf': write.csrf },
          body: JSON.stringify(write.body),
        }
      : {}),
  });
}
