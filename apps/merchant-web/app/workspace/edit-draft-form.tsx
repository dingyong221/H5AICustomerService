'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';

import type { AssistantDraftConfig } from '@h5cs/domain';

import { saveAssistantDraftAction } from './knowledge-actions';
import { DraftFields, type DraftFieldValues } from '../writing/draft-fields';

export function EditDraftForm({
  merchantId,
  assistantId,
  draftRevision,
  draft,
  returnPath,
  csrfToken,
}: {
  merchantId: string;
  assistantId: string;
  draftRevision: number;
  draft: AssistantDraftConfig;
  returnPath?: string;
  csrfToken: string;
}) {
  const [state, action, pending] = useActionState(saveAssistantDraftAction, {
    error: null,
    saved: false,
  });
  const [values, setValues] = useState<DraftFieldValues>({ displayName: '', ...draft });
  return (
    <form action={action} className="assistant-edit-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="assistantId" type="hidden" value={assistantId} />
      <input name="draftRevision" type="hidden" value={draftRevision} />
      <DraftFields
        merchantId={merchantId}
        csrfToken={csrfToken}
        values={values}
        onChange={(field, value) => setValues((previous) => ({ ...previous, [field]: value }))}
      />
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.saved ? (
        <p role="status">
          草稿已保存，原有资料确认已失效。请
          <Link href={returnPath ?? `/${merchantId}/drafts/${assistantId}`}>
            重新打开并核对新修订
          </Link>
          。
        </p>
      ) : null}
      <button disabled={pending || state.saved} type="submit">
        {pending ? '正在保存…' : '保存草稿修订'}
      </button>
    </form>
  );
}
