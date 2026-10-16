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
  const [humanContact, setHumanContact] = useState(draft.humanContact ?? '');
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
      <label>
        人工联系说明（可选）
        <textarea
          name="humanContact"
          maxLength={500}
          rows={3}
          value={humanContact}
          onChange={(event) => setHumanContact(event.target.value)}
          placeholder="填写真实的人工联系方式、服务时间及必要说明"
        />
      </label>
      <p>
        最多 500 字纯文本，不支持
        HTML。仅发布后的说明向消费者展示；此处不实时转接人工。留空表示尚未提供，保存失败会保留当前输入。
      </p>
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
