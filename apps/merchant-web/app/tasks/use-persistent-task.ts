'use client';
import { useEffect, useRef, useState } from 'react';
import {
  fetchTask,
  readTaskReference,
  saveTaskReference,
  taskRequestId,
  unresolvedTaskOutcome,
  taskExecutionState,
} from './persistent-task-client';
import type { ExecutionState } from '@h5cs/contracts';

export type PersistentTaskView = {
  taskId: string;
  state: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  inputRevision: number;
  modelOutcome: string;
  stale: boolean;
  canRetry: boolean;
  result?: unknown;
};
type Reference = {
  requestId: string;
  taskId?: string;
  submission?: { retryOf?: string; body: Record<string, unknown> };
};
type Options<T extends PersistentTaskView> = {
  endpoint: string;
  recoveryKey: string;
  csrf: string;
  enabled: boolean;
  revision: number;
  parseTask: (input: unknown) => T;
  parseCreate: (input: unknown) => Record<string, unknown>;
  onResult?: (task: T) => void;
};
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
const validRequest = (value: unknown): value is string =>
  typeof value === 'string' && /^authoring_[a-f0-9]{32}$/u.test(value);

/** Shared draft/preview client lifecycle. Business use/judge policies stay in their adapters. */
export function usePersistentTask<T extends PersistentTaskView>(options: Options<T>) {
  const [task, setTask] = useState<T | null>(null),
    [reference, setReference] = useState<Reference | null>(null);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [verified, setVerified] = useState(false);
  const [missing, setMissing] = useState(false);
  const [executionState, setExecutionState] = useState<ExecutionState | null>(null);
  const pointer = useRef<Reference | null>(null),
    writing = useRef(false),
    reading = useRef(false);
  const epoch = useRef(0),
    delivered = useRef('');
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  }, [options]);
  function remember(value: Reference | null) {
    saveTaskReference(options.recoveryKey, value);
    pointer.current = value;
    setReference(value);
  }
  function receive(value: unknown) {
    const next = latest.current.parseTask(value);
    setTask(next);
    setVerified(true);
    setMissing(false);
    if (pointer.current) {
      const updated = { requestId: pointer.current.requestId, taskId: next.taskId };
      try {
        remember(updated);
      } catch {
        pointer.current = updated;
        setReference(updated);
      }
    }
    if (next.result && delivered.current !== next.taskId) {
      delivered.current = next.taskId;
      latest.current.onResult?.(next);
    }
    return next;
  }
  async function refresh(): Promise<T | null> {
    const current = pointer.current;
    if (!current || writing.current || reading.current) return null;
    reading.current = true;
    const version = epoch.current;
    try {
      const suffix = current.taskId
        ? `/${current.taskId}`
        : `?requestId=${encodeURIComponent(current.requestId)}`;
      const response = await fetchTask(options.endpoint + suffix);
      const value: unknown = await response.json();
      if (version !== epoch.current) return null;
      setExecutionState(taskExecutionState(response));
      if (!response.ok) throw new Error('Read denied');
      if (value === null) {
        setVerified(false);
        setMissing(true);
        setError('尚未查到原请求。请稍后刷新，或使用原请求编号确认提交；不会自动重新生成。');
        return null;
      }
      const next = receive(value);
      setError('');
      return next;
    } catch {
      if (version === epoch.current) {
        setVerified(false);
        setError('未能确认任务状态，请刷新原任务；不会自动重新生成。');
      }
      return null;
    } finally {
      reading.current = false;
    }
  }
  useEffect(() => {
    try {
      const saved = readTaskReference(options.recoveryKey, (value) => {
        if (!value || typeof value !== 'object') throw new Error('Invalid pointer');
        const record = value as Reference;
        if (
          !validRequest(record.requestId) ||
          (record.taskId !== undefined && !validId(record.taskId))
        )
          throw new Error('Invalid pointer');
        if (record.submission) {
          const input = record.submission;
          if (!input.body || input.body.requestId !== record.requestId)
            throw new Error('Invalid submission');
          if (input.retryOf !== undefined) {
            if (!validId(input.retryOf) || Object.keys(input.body).length !== 1)
              throw new Error('Invalid retry');
          } else latest.current.parseCreate(input.body);
        }
        return record;
      });
      if (saved) {
        pointer.current = saved;
        // Hydrate the external browser record after SSR; it is never a permission grant.
        setReference(saved);
        void refresh();
      }
      setLoaded(true);
    } catch {
      setError('无法读取任务恢复记录，请恢复浏览器存储后刷新页面。');
    }
    // A new user/assistant/field scope remounts this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.recoveryKey]);
  useEffect(() => {
    if (!reference || (reference.taskId && task && !['queued', 'processing'].includes(task.state)))
      return;
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference?.requestId, reference?.taskId, task?.state]);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );

  const canRetry =
    !!task &&
    verified &&
    options.enabled &&
    executionState !== 'paused' &&
    executionState !== 'draining' &&
    executionState !== 'unavailable' &&
    task.canRetry &&
    !task.stale &&
    task.inputRevision === options.revision &&
    task.state === 'failed' &&
    ['none', 'not_dispatched', 'failed'].includes(task.modelOutcome) &&
    reference?.taskId === task.taskId &&
    !reference.submission;
  async function write(
    kind: 'create' | 'retry' | 'cancel' | 'resume',
    body: Record<string, unknown> = {},
  ) {
    if (writing.current || !loaded) return null;
    if (
      (kind === 'create' && (!options.enabled || pointer.current)) ||
      (kind === 'retry' && !canRetry) ||
      (kind === 'resume' && (!options.enabled || !missing || !pointer.current?.submission)) ||
      (['create', 'retry', 'resume'].includes(kind) &&
        ['paused', 'draining', 'unavailable'].includes(executionState ?? '')) ||
      (kind === 'cancel' && (!task || !['queued', 'processing'].includes(task.state)))
    )
      return null;
    writing.current = true;
    epoch.current++;
    const version = epoch.current;
    setBusy(true);
    setError('');
    const previous = pointer.current;
    let sent = false;
    try {
      let payload = body,
        suffix = '';
      if (kind === 'create' || kind === 'retry') {
        const requestId = taskRequestId('authoring');
        payload =
          kind === 'create' ? latest.current.parseCreate({ ...body, requestId }) : { requestId };
        remember({
          requestId,
          submission: { body: payload, ...(kind === 'retry' ? { retryOf: task!.taskId } : {}) },
        });
        suffix = kind === 'retry' ? `/${task!.taskId}/retry` : '';
      } else if (kind === 'resume') {
        payload = previous!.submission!.body;
        suffix = previous!.submission!.retryOf ? `/${previous!.submission!.retryOf}/retry` : '';
      } else {
        suffix = `/${task!.taskId}/cancel`;
        payload = {};
      }
      setVerified(false);
      sent = true;
      const response = await fetchTask(options.endpoint + suffix, {
        body: payload,
        csrf: options.csrf,
      });
      const value: unknown = await response.json();
      if (version !== epoch.current) return null;
      setExecutionState(taskExecutionState(response));
      if (!response.ok) {
        const failure = value as { code?: string; error?: string } | null;
        if (
          response.status >= 400 &&
          response.status < 500 &&
          failure?.code !== 'IDEMPOTENCY_CONFLICT'
        )
          remember(previous);
        throw new Error(failure?.error ?? '操作结果未确认，请刷新原任务。');
      }
      return receive(value);
    } catch (cause) {
      if (version !== epoch.current) return null;
      setVerified(false);
      setError(
        !sent
          ? '未能保存请求恢复信息，本次未发送。请核对输入或浏览器存储。'
          : cause instanceof Error && cause.name === 'Error'
            ? cause.message
            : '操作结果未确认，请刷新原任务；不会自动重新生成。',
      );
      return null;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const canClose =
    !!task &&
    verified &&
    !busy &&
    !reference?.submission &&
    !['queued', 'processing'].includes(task.state) &&
    (!unresolvedTaskOutcome(task) ||
      (['failed', 'cancelled'].includes(task.state) &&
        ['none', 'not_dispatched', 'failed', 'succeeded'].includes(task.modelOutcome)));
  function close() {
    if (!canClose || writing.current) return false;
    try {
      remember(null);
    } catch {
      setError('无法清除恢复记录，请恢复浏览器存储后重试。');
      return false;
    }
    epoch.current++;
    delivered.current = '';
    setTask(null);
    setVerified(false);
    setError('');
    setMissing(false);
    return true;
  }
  return {
    task,
    executionState,
    executionBlocked: ['paused', 'draining', 'unavailable'].includes(executionState ?? ''),
    bound: !!reference,
    busy,
    loaded,
    error,
    verified,
    canRetry,
    canClose,
    canResume:
      missing &&
      !!reference?.submission &&
      options.enabled &&
      !['paused', 'draining', 'unavailable'].includes(executionState ?? ''),
    reference,
    refresh,
    write,
    close,
  };
}
