'use client';
import type { PersistentTaskView } from './use-persistent-task';
import { executionNotice, unresolvedTaskOutcome } from './persistent-task-client';
import type { ExecutionState } from '@h5cs/contracts';

export function taskProgress(task: PersistentTaskView | null, revision: number) {
  if (!task) return '正在确认提交结果…';
  if (task.state === 'cancelled') return '任务已取消；已发出的模型请求仍可能计费。';
  if (task.stale || task.inputRevision !== revision) return '结果已过期，不能使用当前结果。';
  if (task.state === 'queued') return '正在排队，刷新页面后可恢复本次任务。';
  if (task.state === 'processing') return '正在处理，完成后请核对结果。';
  if (task.state === 'failed' && !['unknown', 'dispatched'].includes(task.modelOutcome))
    return task.canRetry ? '任务失败，可手动重试。' : '任务未完成，请核对当前资料。';
  if (unresolvedTaskOutcome(task)) return '模型调用结果未确认，不能重试；请稍后刷新原任务。';
  return '任务已完成，请人工核对结果。';
}

export function TaskControls({
  task,
  revision,
  bound,
  busy,
  error,
  canRetry,
  canResume,
  canClose,
  refresh,
  write,
  onClose,
  executionState = null,
}: {
  task: PersistentTaskView | null;
  revision: number;
  bound: boolean;
  busy: boolean;
  error: string;
  canRetry: boolean;
  canResume: boolean;
  canClose: boolean;
  refresh: () => unknown;
  write: (kind: 'cancel' | 'retry' | 'resume') => unknown;
  onClose: () => void;
  executionState?: ExecutionState | null;
}) {
  return (
    <>
      {executionNotice(executionState) &&
      (!task || ['queued', 'processing'].includes(task.state)) ? (
        <p role="status">{executionNotice(executionState)}</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {bound ? (
        <section className="knowledge-task-status authoring-task-status" aria-label="当前生成任务">
          <p role="status">{taskProgress(task, revision)}</p>
          {task ? <small>来源草稿修订 {task.inputRevision}</small> : null}
          <div className="knowledge-task-actions">
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              刷新任务
            </button>
            {task && ['queued', 'processing'].includes(task.state) ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      '取消后不再使用此任务结果；已发出的模型请求仍可能计费。确认取消？',
                    )
                  )
                    void write('cancel');
                }}
              >
                取消任务
              </button>
            ) : null}
            {canRetry ? (
              <button type="button" disabled={busy} onClick={() => void write('retry')}>
                重试任务
              </button>
            ) : null}
            {canResume ? (
              <button type="button" disabled={busy} onClick={() => void write('resume')}>
                确认提交原任务
              </button>
            ) : null}
            {canClose ? (
              <button type="button" disabled={busy} onClick={onClose}>
                关闭已结束任务
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
