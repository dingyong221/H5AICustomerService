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
import { EXECUTION_STATE_HEADER, executionStateSchema, type ExecutionState } from '@h5cs/contracts';

export function taskExecutionState(response: Response): ExecutionState | null {
  const parsed = executionStateSchema.safeParse(response.headers?.get(EXECUTION_STATE_HEADER));
  return parsed.success ? parsed.data : null;
}
export function executionNotice(state: ExecutionState | null): string | null {
  if (state === 'paused')
    return 'AI 任务运行已暂停，输入、原任务和已有结果保留。可刷新原任务或联系平台运营；恢复后继续查询原任务，无需重新生成。';
  if (state === 'draining')
    return '任务运行已暂停，已发出的调用仍在核对结果，可能计费。请继续查询原任务，不要重复提交。';
  if (state === 'unavailable') return '暂时无法确认运行状态；可查询原任务，已有结果仍可核对。';
  return null;
}
