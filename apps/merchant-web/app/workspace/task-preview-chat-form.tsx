'use client';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  authoringTaskSchema,
  previewReplyRequestSchema,
  type PreviewReplyTask,
} from '@h5cs/contracts';
import { usePersistentTask } from '../tasks/use-persistent-task';
import { TaskControls } from '../tasks/task-controls';
import { PreviewVerdictForm } from './governance-controls';
import type { PreviewChatProps } from './preview-chat-form';

export function TaskPreviewChatForm({
  merchantId,
  assistantId,
  draftRevision,
  csrfToken,
  available,
  lastCheck,
  taskUserId,
  asyncPreviewEnabled = false,
  fallback,
}: PreviewChatProps & { taskUserId: string; fallback: ReactNode }) {
  const [question, setQuestion] = useState('');
  const router = useRouter();
  const flow = usePersistentTask<PreviewReplyTask>({
    endpoint: `/${merchantId}/preview/${assistantId}/reply-tasks`,
    recoveryKey: `h5cs:preview-reply:${taskUserId}:${merchantId}:${assistantId}`,
    csrf: csrfToken,
    enabled: asyncPreviewEnabled && available,
    revision: draftRevision,
    parseCreate: (value) => previewReplyRequestSchema.parse(value),
    parseTask: (value) => {
      const task = authoringTaskSchema.parse(value);
      if (task.kind !== 'preview.reply') throw new Error('Wrong task scope');
      return task;
    },
    onResult: () => router.refresh(),
  });
  if (flow.loaded && !asyncPreviewEnabled && !flow.bound) return fallback;
  const task = flow.task;
  const current =
    flow.verified &&
    task?.state === 'completed' &&
    task.modelOutcome === 'succeeded' &&
    !task.stale &&
    task.inputRevision === draftRevision;
  const result = current ? task?.result : null;
  const matchedCheck = result?.checkId === lastCheck?.checkId;
  const reviewCheckId =
    result && task?.canJudge && matchedCheck && lastCheck?.state === 'needs_review'
      ? result.checkId
      : !flow.bound && lastCheck?.state === 'needs_review'
        ? lastCheck.checkId
        : null;
  return (
    <>
      <form
        data-usage="preview.send"
        className="assistant-preview-form"
        onSubmit={(event) => {
          event.preventDefault();
          void flow.write('create', { revision: draftRevision, question });
        }}
      >
        <label>
          试聊问题
          <textarea
            name="question"
            maxLength={2000}
            rows={3}
            required
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            disabled={flow.bound || flow.busy}
            placeholder="例如：你们提供哪些服务？价格怎么确定？"
          />
        </label>
        <p>试聊会把当前已保存草稿和问题发送至阿里云千问。回答仍需你核对并判定，不会自动发布。</p>
        <button
          type="submit"
          disabled={
            !flow.loaded ||
            !asyncPreviewEnabled ||
            !available ||
            flow.bound ||
            flow.busy ||
            !question.trim()
          }
        >
          发送测试问题
        </button>
        {!available ? <p role="status">AI 对话服务尚未就绪，暂不能试聊。</p> : null}
      </form>
      <TaskControls
        {...flow}
        revision={draftRevision}
        onClose={() => {
          if (
            window.confirm(
              '关闭当前任务展示后，可明确发起新的试聊。已保存的试聊记录仍会保留。确认关闭？',
            )
          )
            flow.close();
        }}
      />
      {task && (task.stale || task.inputRevision !== draftRevision) ? (
        <p role="status">草稿或试聊记录已变化，旧回答不能用于本次判定。</p>
      ) : null}
      {result ? (
        <div className="assistant-preview-answer" aria-live="polite">
          <strong>AI 试聊回答</strong>
          {matchedCheck && lastCheck?.question ? (
            <p>
              <strong>问题：</strong>
              {lastCheck.question}
            </p>
          ) : null}
          <p>{result.answer}</p>
          <details className="preview-evidence">
            <summary>核对本次试聊依据 · 草稿修订 {task!.inputRevision}</summary>
            <p>以下为本次发送的已保存草稿资料，请核对回答是否有依据。</p>
            {result.evidence.map((item) => (
              <details key={item.label}>
                <summary>{item.label}</summary>
                <pre>{item.text}</pre>
              </details>
            ))}
          </details>
        </div>
      ) : null}
      {!flow.bound && lastCheck?.answer ? (
        <details className="assistant-preview-answer" open={lastCheck.state === 'needs_review'}>
          <summary>本修订已保存的试聊记录</summary>
          <p>
            <strong>问题：</strong>
            {lastCheck.question}
          </p>
          <p>{lastCheck.answer}</p>
        </details>
      ) : null}
      {reviewCheckId ? (
        <PreviewVerdictForm
          key={reviewCheckId}
          merchantId={merchantId}
          assistantId={assistantId}
          draftRevision={draftRevision}
          csrfToken={csrfToken}
          checkId={reviewCheckId}
        />
      ) : null}
    </>
  );
}
