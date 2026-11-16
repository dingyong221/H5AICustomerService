'use client';
import { useEffect, useRef, useState } from 'react';
import {
  fetchTask,
  readTaskReference,
  saveTaskReference,
  taskRequestId,
  unresolvedTaskOutcome,
  taskExecutionState,
} from '../tasks/persistent-task-client';
import {
  knowledgeOrganizationApplySchema,
  knowledgeOrganizationRequestIdSchema,
  knowledgeOrganizationRequestSchema,
  knowledgeOrganizationRetrySchema,
  knowledgeOrganizationTaskSchema,
  type KnowledgeOrganizationApply,
  type KnowledgeOrganizationTask,
  type KnowledgeOrganizationRequest,
  type ExecutionState,
} from '@h5cs/contracts';

type Reference = {
  requestId: string;
  taskId?: string;
  pendingApply?: KnowledgeOrganizationApply;
  submission?: { retryOf?: string; body: KnowledgeOrganizationRequest | { requestId: string } };
};
const unresolved = unresolvedTaskOutcome;
export function organizationMessage(task: KnowledgeOrganizationTask, revision: number) {
  if (task.appliedRevision) return `已保存至草稿修订 ${task.appliedRevision}，试聊并发布后生效。`;
  if (task.state === 'cancelled') return '任务已取消，结果不会采纳；已发出的模型请求仍可能计费。';
  if (task.stale || task.inputRevision !== revision)
    return '候选已过期：草稿或材料发生变化，不能采纳或重试。';
  if (task.state === 'queued') return '正在排队，刷新页面后可继续查看进度。';
  if (task.state === 'processing') return '正在整理，完成后请核对候选内容。';
  if (unresolved(task)) return '模型调用结果未确认，不能重试；请稍后查询原任务。';
  if (task.state === 'failed')
    return task.canRetry ? '整理失败，可手动重试。' : '整理未完成，请核对材料和任务状态。';
  return '整理完成，尚未保存。请核对内容并确认采纳。';
}

export function useOrganizationTask(options: {
  endpoint: string;
  csrfToken: string;
  recoveryKey?: string;
  enabled: boolean;
  revision: number;
  onCandidate: (task: KnowledgeOrganizationTask, pendingApply?: KnowledgeOrganizationApply) => void;
}) {
  const [task, setTask] = useState<KnowledgeOrganizationTask | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [loaded, setLoaded] = useState(!options.recoveryKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const [submissionMissing, setSubmissionMissing] = useState(false);
  const [confirmedStale, setConfirmedStale] = useState(false);
  const [executionState, setExecutionState] = useState<ExecutionState | null>(null);
  const current = useRef<Reference | null>(null),
    lock = useRef(false),
    reading = useRef(false);
  const epoch = useRef(0),
    delivered = useRef('');
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  }, [options]);
  function remember(value: Reference | null) {
    saveTaskReference(options.recoveryKey, value);
    current.current = value;
    setReference(value);
  }
  function receive(value: unknown) {
    const next = knowledgeOrganizationTaskSchema.parse(value);
    setTask(next);
    setVerified(true);
    setSubmissionMissing(false);
    const pointer = current.current;
    if (pointer) {
      const updated: Reference = {
        requestId: pointer.requestId,
        taskId: next.taskId,
        ...(!next.appliedRevision && pointer.pendingApply
          ? { pendingApply: pointer.pendingApply }
          : {}),
      };
      // The request ID was durably saved before dispatch; it remains a recovery key
      // even if this best-effort task-ID update fails (for example storage is full).
      try {
        remember(updated);
      } catch {
        current.current = updated;
        setReference(updated);
      }
    }
    if (next.result && delivered.current !== next.taskId && !next.appliedRevision) {
      delivered.current = next.taskId;
      latest.current.onCandidate(next, current.current?.pendingApply);
    }
    return next;
  }
  async function refresh() {
    const pointer = current.current;
    if (!pointer || lock.current || reading.current) return;
    reading.current = true;
    setConfirmedStale(false);
    const version = epoch.current;
    try {
      const url = pointer.taskId
        ? `/${pointer.taskId}`
        : `?requestId=${encodeURIComponent(pointer.requestId)}`;
      const response = await fetchTask(`${options.endpoint}/organize-tasks${url}`);
      const value: unknown = await response.json();
      if (version !== epoch.current) return;
      setExecutionState(taskExecutionState(response));
      if (!response.ok) throw new Error('任务暂不可读，请确认登录及管理权限后再刷新。');
      if (value === null) {
        setVerified(false);
        setSubmissionMissing(true);
        setError('尚未查到提交结果。可稍后刷新，或使用原请求编号确认提交；不会自动重新提交。');
      } else {
        const readback = receive(value);
        setConfirmedStale(readback.stale && readback.appliedRevision === undefined);
        setError('');
      }
    } catch {
      if (version === epoch.current) {
        setVerified(false);
        setError('未能确认任务状态，请刷新任务；不会自动重新提交。');
      }
    } finally {
      reading.current = false;
    }
  }
  useEffect(() => {
    if (!options.recoveryKey) return;
    try {
      const value = readTaskReference(options.recoveryKey, (value) => value as Reference);
      if (value) {
        if (
          !knowledgeOrganizationRequestIdSchema.safeParse(value.requestId).success ||
          (value.taskId !== undefined && !/^[a-f0-9]{32}$/u.test(value.taskId)) ||
          (value.pendingApply !== undefined &&
            !knowledgeOrganizationApplySchema.safeParse(value.pendingApply).success) ||
          (value.submission !== undefined &&
            (value.submission.body.requestId !== value.requestId ||
              (value.submission.retryOf !== undefined
                ? !/^[a-f0-9]{32}$/u.test(value.submission.retryOf) ||
                  !knowledgeOrganizationRetrySchema.safeParse(value.submission.body).success
                : !knowledgeOrganizationRequestSchema.safeParse(value.submission.body).success)))
        )
          throw new Error('Invalid reference');
        current.current = value;
        // Hydrate external, per-tab browser storage only after SSR has completed.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setReference(value);
        void refresh();
      }
      setLoaded(true);
    } catch {
      setError('无法读取任务恢复记录，请恢复浏览器存储后刷新页面。');
    }
    // Scope changes remount MaterialManager via its server-provided key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.recoveryKey]);
  useEffect(() => {
    if (!reference || (task && !['queued', 'processing'].includes(task.state))) return;
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference?.requestId, task?.state]);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );

  async function write(
    kind: 'create' | 'retry' | 'cancel' | 'apply' | 'resume',
    body: Record<string, unknown>,
  ) {
    if (lock.current) return false;
    if (
      ['create', 'retry', 'resume'].includes(kind) &&
      ['paused', 'draining', 'unavailable'].includes(executionState ?? '')
    )
      return false;
    lock.current = true;
    setConfirmedStale(false);
    epoch.current++;
    setBusy(true);
    setError('');
    const previous = current.current;
    let sent = false;
    try {
      let pointer = previous;
      let payload = body;
      let suffix = kind === 'create' ? '' : `/${task?.taskId}/${kind}`;
      if (kind === 'resume') {
        if (!options.enabled || !submissionMissing || !previous?.submission) return false;
        payload = previous.submission.body;
        suffix = previous.submission.retryOf ? `/${previous.submission.retryOf}/retry` : '';
      } else if (kind === 'create' || kind === 'retry') {
        if (
          !options.enabled ||
          !loaded ||
          (kind === 'create' && previous) ||
          (kind === 'retry' &&
            (!task?.canRetry ||
              previous?.taskId !== task.taskId ||
              !!previous?.submission ||
              task.stale ||
              task.inputRevision !== options.revision ||
              unresolved(task)))
        )
          return false;
        pointer = { requestId: taskRequestId('organize') };
        payload = { ...body, requestId: pointer.requestId };
        pointer.submission =
          kind === 'create'
            ? { body: knowledgeOrganizationRequestSchema.parse(payload) }
            : { retryOf: task!.taskId, body: knowledgeOrganizationRetrySchema.parse(payload) };
        remember(pointer);
        setVerified(false);
      } else if (kind === 'apply') {
        if (
          !task?.canApply ||
          !verified ||
          task.stale ||
          task.appliedRevision ||
          task.inputRevision !== options.revision ||
          !task.result ||
          task.state !== 'completed' ||
          task.modelOutcome !== 'succeeded'
        )
          return false;
        const parsed = knowledgeOrganizationApplySchema.parse(previous?.pendingApply ?? body);
        if (parsed.revision !== task.inputRevision || !previous) return false;
        payload = parsed;
        remember({ ...previous, pendingApply: parsed });
      }
      sent = true;
      const response = await fetchTask(`${options.endpoint}/organize-tasks${suffix}`, {
        body: payload,
        csrf: options.csrfToken,
      });
      const value = (await response.json()) as {
        code?: string;
        error?: string;
        saved?: boolean;
        revision?: number;
      };
      setExecutionState(taskExecutionState(response));
      if (!response.ok) {
        if (
          response.status >= 400 &&
          response.status < 500 &&
          value.code !== 'IDEMPOTENCY_CONFLICT'
        ) {
          // A known rejection did not accept this mutation. Unknown responses retain
          // their reference and are reconciled only through GET.
          remember(previous);
        }
        throw new Error(value.error ?? '操作结果未确认，请查询原任务。');
      }
      if (kind === 'apply') {
        if (
          value.saved !== true ||
          !Number.isSafeInteger(value.revision) ||
          Number(value.revision) <= task!.inputRevision
        )
          throw new Error('未能确认保存结果，请刷新任务核对。');
        remember({ requestId: previous!.requestId, taskId: task!.taskId });
        setTask({ ...task!, appliedRevision: value.revision!, canApply: false });
      } else receive(value);
      return true;
    } catch (cause) {
      setVerified(false);
      setError(
        !sent
          ? '无法保存任务恢复信息，本次未发送。请恢复浏览器存储后重试。'
          : cause instanceof Error && cause.name === 'Error'
            ? cause.message
            : '网络中断或结果未确认，请刷新原任务；不会自动重新提交。',
      );
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const canDiscardPending =
    confirmedStale &&
    verified &&
    !!reference?.pendingApply &&
    !reference.submission &&
    reference.taskId === task?.taskId &&
    !!task?.stale &&
    task.appliedRevision === undefined &&
    task.state === 'completed' &&
    task.modelOutcome === 'succeeded' &&
    !busy;
  function close(discardPending = false) {
    if (
      !task ||
      busy ||
      reference?.submission ||
      (reference?.pendingApply &&
        !(discardPending && canDiscardPending && !reading.current && !lock.current)) ||
      ['queued', 'processing'].includes(task.state) ||
      unresolved(task)
    )
      return false;
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
    setConfirmedStale(false);
    setError('');
    return true;
  }
  return {
    task,
    executionState,
    executionBlocked: ['paused', 'draining', 'unavailable'].includes(executionState ?? ''),
    busy,
    error,
    loaded,
    reference,
    refresh,
    write,
    close,
    canDiscardPending,
    discardPending: () => close(true),
    bound: !!reference,
    canResume:
      submissionMissing &&
      !!reference?.submission &&
      options.enabled &&
      !['paused', 'draining', 'unavailable'].includes(executionState ?? ''),
    pendingApply: !!reference?.pendingApply,
    canApply:
      !!task?.canApply &&
      verified &&
      !task.stale &&
      !task.appliedRevision &&
      !!task.result &&
      task.state === 'completed' &&
      task.modelOutcome === 'succeeded' &&
      task.inputRevision === options.revision,
    canRetry:
      !!task?.canRetry &&
      reference?.taskId === task.taskId &&
      !reference?.submission &&
      verified &&
      !task.stale &&
      task.inputRevision === options.revision &&
      !unresolved(task) &&
      !['paused', 'draining', 'unavailable'].includes(executionState ?? '') &&
      options.enabled,
    canClose:
      !!task &&
      !busy &&
      !reference?.submission &&
      !reference?.pendingApply &&
      !['queued', 'processing'].includes(task.state) &&
      !unresolved(task),
  };
}
