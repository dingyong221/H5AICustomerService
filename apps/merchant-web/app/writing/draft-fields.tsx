'use client';

import { useRef, useState } from 'react';
import { writingFields, type WritingField } from '@h5cs/contracts';
import { WritingAssistant } from './writing-assistant';

export type DraftFieldValues = Record<WritingField, string>;
export function DraftFields({
  merchantId,
  csrfToken,
  values,
  onChange,
  includeName = false,
}: {
  merchantId: string;
  csrfToken: string;
  values: DraftFieldValues;
  onChange: (field: WritingField, value: string) => void;
  includeName?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<{ field: WritingField; original: string } | null>(null);
  const [undo, setUndo] = useState<{ field: WritingField; before: string; applied: string } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  function apply(text: string) {
    if (!selected) return;
    if (values[selected.field] !== selected.original) {
      setMessage('原字段已被修改，请关闭助手后重新打开，以免覆盖你的新内容。');
      return;
    }
    const normalized = writingFields[selected.field].multiline ? text : text.replace(/\s+/gu, ' ');
    setUndo({ field: selected.field, before: selected.original, applied: normalized });
    onChange(selected.field, normalized);
    setSelected(null);
    setMessage('已填入表单，尚未保存。请核对后点击创建或保存草稿。');
    root.current?.querySelector<HTMLElement>(`[name="${selected.field}"]`)?.focus();
  }
  return (
    <div ref={root} className="draft-fields">
      <p>不知道怎么写？每个字段旁的“帮我写”可以将简短描述整理成多个备选。</p>
      {(Object.keys(writingFields) as WritingField[])
        .filter((field) => includeName || field !== 'displayName')
        .map((field) => (
          <div className="draft-field" key={field}>
            <label>
              {writingFields[field].label}
              {writingFields[field].multiline ? (
                <textarea
                  name={field}
                  required
                  value={values[field]}
                  maxLength={writingFields[field].maximum}
                  rows={field === 'materialsSummary' ? 8 : 3}
                  onChange={(event) => onChange(field, event.target.value)}
                />
              ) : (
                <input
                  name={field}
                  required
                  value={values[field]}
                  maxLength={writingFields[field].maximum}
                  onChange={(event) => onChange(field, event.target.value)}
                />
              )}
            </label>
            <button
              type="button"
              className="writing-launcher"
              onClick={() => {
                setMessage(null);
                setSelected(selected?.field === field ? null : { field, original: values[field] });
              }}
            >
              {selected?.field === field ? '关闭填写助手' : `帮我写${writingFields[field].label}`}
            </button>
            {selected?.field === field ? (
              <WritingAssistant
                key={field}
                merchantId={merchantId}
                csrfToken={csrfToken}
                field={field}
                currentText={selected.original}
                onApply={apply}
              />
            ) : null}
          </div>
        ))}
      {message ? <p role="status">{message}</p> : null}
      {undo ? (
        <button
          type="button"
          className="writing-launcher"
          disabled={values[undo.field] !== undo.applied}
          onClick={() => {
            onChange(undo.field, undo.before);
            setUndo(null);
            setMessage('已恢复填入前的文字。仍需保存草稿。');
          }}
        >
          撤销上次填入
        </button>
      ) : null}
    </div>
  );
}
