'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  authoringTaskSchema,
  draftExpandRequestSchema,
  writingFields,
  type DraftExpandTask,
  type WritingField,
} from '@h5cs/contracts';
import { usePersistentTask } from '../tasks/use-persistent-task';
import { TaskControls } from '../tasks/task-controls';

export type DraftTaskScope = {
  userId: string;
  assistantId: string;
  revision: number;
  currentRevision: number;
  enabled: boolean;
};
export async function fieldHash(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function TaskWritingAssistant({
  merchantId,
  csrfToken,
  field,
  currentText,
  localText,
  scope,
  onApply,
  fallback,
}: {
  merchantId: string;
  csrfToken: string;
  field: WritingField;
  currentText: string;
  localText: string;
  scope: DraftTaskScope;
  onApply: (text: string) => void;
  fallback: ReactNode;
}) {
  const [brief, setBrief] = useState(''),
    [consent, setConsent] = useState(false);
  const [options, setOptions] = useState<string[]>([]),
    [message, setMessage] = useState('');
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false),
    mounted = useRef(true);
  const live = useRef({ localText, scope, onApply });
  useEffect(() => {
    live.current = { localText, scope, onApply };
  }, [localText, scope, onApply]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const flow = usePersistentTask<DraftExpandTask>({
    endpoint: `/${merchantId}/drafts/${scope.assistantId}/expand-tasks`,
    recoveryKey: `h5cs:draft-expand:${scope.userId}:${merchantId}:${scope.assistantId}:${field}`,
    csrf: csrfToken,
    enabled: scope.enabled,
    revision: scope.currentRevision,
    parseCreate: (value) => draftExpandRequestSchema.parse(value),
    parseTask: (value) => {
      const task = authoringTaskSchema.parse(value);
      if (task.kind !== 'draft.expand' || task.field !== field) throw new Error('Wrong task scope');
      return task;
    },
    onResult: (task) => {
      if (task.result) setOptions([...task.result.options]);
    },
  });
  const ready =
    flow.verified &&
    flow.task?.canUse &&
    flow.task.state === 'completed' &&
    flow.task.modelOutcome === 'succeeded' &&
    !flow.task.stale &&
    flow.task.inputRevision === scope.revision &&
    scope.revision === scope.currentRevision;
  async function apply(text: string) {
    if (applyingRef.current || !ready || flow.busy) return;
    applyingRef.current = true;
    setApplying(true);
    setMessage('');
    const before = live.current.localText;
    try {
      const task = await flow.refresh();
      const hash = await fieldHash(before);
      const current = live.current;
      if (!mounted.current) return;
      if (
        !task ||
        !task.canUse ||
        task.state !== 'completed' ||
        task.modelOutcome !== 'succeeded' ||
        !task.result ||
        task.stale ||
        task.inputRevision !== current.scope.revision ||
        task.inputRevision !== current.scope.currentRevision ||
        task.inputFieldHash !== hash ||
        current.localText !== before
      ) {
        setMessage(
          '原字段或草稿已变化，未填入任何文字。请保留当前输入，关闭填写助手后重新打开核对。',
        );
        return;
      }
      current.onApply(text.trim());
    } catch {
      if (mounted.current) setMessage('未能确认原字段和任务状态，未填入任何文字。请刷新任务。');
    } finally {
      applyingRef.current = false;
      if (mounted.current) setApplying(false);
    }
  }
  if (flow.loaded && !scope.enabled && !flow.bound) return fallback;
  return (
    <section
      className="writing-panel"
      aria-label={`${writingFields[field].label}填写助手`}
      aria-busy={flow.busy || applying}
    >
      <h3>帮我写 {writingFields[field].label}</h3>
      <p>参考当前字段生成备选，填入后仍需核对并保存草稿。</p>
      <label>
        简短描述
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder={writingFields[field].example}
          disabled={flow.bound || flow.busy}
        />
      </label>
      <label className="writing-consent">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          disabled={flow.bound || flow.busy}
        />
        我同意将此简述和当前字段文字发送至阿里云千问生成文案。
      </label>
      <button
        type="button"
        data-usage="writing.generate"
        disabled={
          !flow.loaded ||
          flow.executionBlocked ||
          !scope.enabled ||
          flow.bound ||
          flow.busy ||
          !brief.trim() ||
          !consent ||
          scope.revision !== scope.currentRevision
        }
        onClick={() =>
          void flow.write('create', {
            revision: scope.revision,
            field,
            brief,
            currentText,
            consent: true,
          })
        }
      >
        生成备选文案
      </button>
      <TaskControls
        {...flow}
        revision={scope.currentRevision}
        busy={flow.busy || applying}
        onClose={() => {
          if (
            window.confirm('关闭会清除本页候选，请先复制需要保留的文字。确认关闭？') &&
            flow.close()
          ) {
            setOptions([]);
            setMessage('已关闭，可以明确发起新的生成。');
          }
        }}
      />
      {message ? <p role="status">{message}</p> : null}
      {options.length && flow.task?.state === 'completed' ? (
        <div className="writing-results">
          <p className="writing-warning">请核对价格、优惠和承诺；未知信息保留“需商家确认”。</p>
          {options.map((option, index) => (
            <article key={index}>
              <label>
                备选 {index + 1}
                <textarea
                  value={option}
                  disabled={applying || flow.busy}
                  maxLength={writingFields[field].maximum}
                  rows={writingFields[field].multiline ? 5 : 3}
                  onChange={(e) =>
                    setOptions((items) =>
                      items.map((value, i) => (i === index ? e.target.value : value)),
                    )
                  }
                />
              </label>
              <button
                type="button"
                disabled={!ready || flow.busy || applying || !option.trim()}
                onClick={() => void apply(option)}
              >
                填入此字段
              </button>
            </article>
          ))}
          {flow.task.result?.reminders.length ? (
            <aside>
              <strong>还需要你确认</strong>
              <ul>
                {flow.task.result.reminders.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </aside>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
