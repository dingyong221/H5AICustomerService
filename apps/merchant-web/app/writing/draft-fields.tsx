'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { writingFields, type WritingField } from '@h5cs/contracts';
import { WritingAssistant } from './writing-assistant';

export type DraftFieldValues = Record<WritingField, string>;
export function DraftFields({
  merchantId,
  csrfToken,
  values,
  onChange,
  includeName = false,
  responseFields,
}: {
  merchantId: string;
  csrfToken: string;
  values: DraftFieldValues;
  onChange: (field: WritingField, value: string) => void;
  includeName?: boolean;
  responseFields?: ReactNode;
}) {
  const fieldId = useId();
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
      <p className="draft-form-group__hint">
        按三组填写；不确定的信息保留“需商家确认”。字段旁可使用“帮我写”。
      </p>
      {(
        [
          {
            title: '基本资料',
            fields: ['displayName', 'industry', 'businessScope', 'materialsSummary'],
          },
          { title: '交易规则', fields: ['pricingSummary', 'promotionSummary'] },
          { title: '回复设置', fields: ['welcomeMessage', 'insufficientInfoMessage'] },
        ] as const
      ).map((group, index) => (
        <details className="draft-form-group" key={group.title} open={index === 0}>
          <summary className="draft-form-group__summary">{group.title}</summary>
          {group.fields
            .filter((field) => includeName || field !== 'displayName')
            .map((field) => (
              <div className="draft-field" key={field}>
                <label htmlFor={`${fieldId}-${field}`}>{writingFields[field].label}</label>
                {writingFields[field].multiline ? (
                  <textarea
                    id={`${fieldId}-${field}`}
                    name={field}
                    required
                    value={values[field]}
                    maxLength={writingFields[field].maximum}
                    rows={field === 'materialsSummary' ? 4 : 3}
                    onInvalid={(event) => {
                      const group = event.currentTarget.closest('details');
                      if (group) group.open = true;
                    }}
                    onChange={(event) => onChange(field, event.target.value)}
                  />
                ) : (
                  <input
                    id={`${fieldId}-${field}`}
                    name={field}
                    required
                    value={values[field]}
                    maxLength={writingFields[field].maximum}
                    onInvalid={(event) => {
                      const group = event.currentTarget.closest('details');
                      if (group) group.open = true;
                    }}
                    onChange={(event) => onChange(field, event.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="writing-launcher"
                  onClick={() => {
                    setMessage(null);
                    setSelected(
                      selected?.field === field ? null : { field, original: values[field] },
                    );
                  }}
                >
                  {selected?.field === field
                    ? '关闭填写助手'
                    : `帮我写${writingFields[field].label}`}
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
          {group.title === '回复设置' ? responseFields : null}
        </details>
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
