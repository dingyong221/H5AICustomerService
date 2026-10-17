'use client';
import { useState } from 'react';
import { writingFields, type WritingField } from '@h5cs/contracts';
import { WritingAssistant } from './writing-assistant';

export function WritingWorkbench({
  merchantId,
  csrfToken,
}: {
  merchantId: string;
  csrfToken: string;
}) {
  const [field, setField] = useState<WritingField>('businessScope');
  return (
    <div className="merchant-account-card assistant-create-card writing-workbench">
      <label>
        想要撰写的内容
        <select value={field} onChange={(event) => setField(event.target.value as WritingField)}>
          {Object.entries(writingFields).map(([key, spec]) => (
            <option key={key} value={key}>
              {spec.label}
            </option>
          ))}
        </select>
      </label>
      <WritingAssistant key={field} merchantId={merchantId} csrfToken={csrfToken} field={field} />
    </div>
  );
}
