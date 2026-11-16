'use client';

import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import type { AssistantDraftConfig } from '@h5cs/domain';

import { saveAssistantDraftAction } from './knowledge-actions';
import { DraftFields, type DraftFieldValues } from '../writing/draft-fields';
import { merchantPath } from '../tenant-paths';
import { useUnsavedForm } from './use-unsaved-form';

const subscribe = () => () => undefined;
const clientReady = () => true;
const serverReady = () => false;

export function EditDraftForm({
  merchantId,
  assistantId,
  draftRevision,
  draft,
  returnPath,
  continueHref,
  csrfToken,
  taskUserId,
  asyncExpandEnabled = false,
}: {
  merchantId: string;
  assistantId: string;
  draftRevision: number;
  draft: AssistantDraftConfig;
  returnPath?: string;
  continueHref?: string;
  csrfToken: string;
  taskUserId?: string;
  asyncExpandEnabled?: boolean;
}) {
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [state, action, pending] = useActionState(saveAssistantDraftAction, {
    error: null,
    saved: false,
  });
  const [values, setValues] = useState<DraftFieldValues>({ displayName: '', ...draft });
  const [humanContact, setHumanContact] = useState(draft.humanContact ?? '');
  const [editingRevision, setEditingRevision] = useState(draftRevision);
  const humanContactId = useId();
  const router = useRouter();
  const signature = JSON.stringify({ ...values, humanContact });
  const [savedSignature, setSavedSignature] = useState(signature);
  const dirty = signature !== savedSignature;
  const permitNavigation = useUnsavedForm(dirty);
  const advanceRequested = useRef(false);
  const handled = useRef<typeof state | null>(null);
  const next =
    continueHref === merchantPath(merchantId, 'knowledge', assistantId) ? continueHref : null;
  useEffect(() => {
    if (!state.saved || handled.current === state) return;
    handled.current = state;
    setSavedSignature(signature);
    if (advanceRequested.current && next) {
      permitNavigation();
      router.push(next);
    } else {
      router.refresh();
    }
  }, [state, signature, next, permitNavigation, router]);
  // Keep clean inputs aligned with a fresh server revision without remounting
  // useActionState. Dirty inputs retain their original optimistic-lock revision.
  if (draftRevision !== editingRevision && !dirty && !pending) {
    const refreshed = { displayName: '', ...draft };
    const contact = draft.humanContact ?? '';
    setValues(refreshed);
    setHumanContact(contact);
    setSavedSignature(JSON.stringify({ ...refreshed, humanContact: contact }));
    setEditingRevision(draftRevision);
  }
  return (
    <form data-usage="draft.save" action={action} className="assistant-edit-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="assistantId" type="hidden" value={assistantId} />
      <input name="draftRevision" type="hidden" value={editingRevision} />
      <fieldset disabled={!hydrated || pending} className="draft-form-fields">
        <DraftFields
          merchantId={merchantId}
          csrfToken={csrfToken}
          {...(taskUserId
            ? {
                taskScope: {
                  userId: taskUserId,
                  assistantId,
                  revision: editingRevision,
                  currentRevision: draftRevision,
                  enabled: asyncExpandEnabled,
                },
              }
            : {})}
          values={values}
          onChange={(field, value) => setValues((previous) => ({ ...previous, [field]: value }))}
          responseFields={
            <div className="draft-field">
              <label htmlFor={humanContactId}>人工联系说明（可选）</label>
              <textarea
                id={humanContactId}
                name="humanContact"
                maxLength={500}
                rows={3}
                value={humanContact}
                onChange={(event) => setHumanContact(event.target.value)}
                placeholder="真实联系方式和服务时间；不提供实时人工转接"
              />
              <p className="draft-form-group__hint">
                最多 500 字，发布后消费者可见。不要填写密码或敏感资料。
              </p>
            </div>
          }
        />
      </fieldset>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {draftRevision !== editingRevision && dirty ? (
        <p role="alert">
          资料已在其他页面更新，当前输入已保留。请先复制未保存文字，再重新打开当前客服核对，避免覆盖新修订。
        </p>
      ) : null}
      {dirty ? <p role="status">有未保存的修改，请保存后继续。</p> : null}
      {state.saved && !dirty ? (
        <p role="status">
          草稿已保存，发布前需重新核对。
          <Link href={returnPath ?? `/${merchantId}/drafts/${assistantId}`}>查看当前修订</Link>。
        </p>
      ) : null}
      <div className="draft-form-actions">
        <button
          disabled={!hydrated || pending}
          type="submit"
          className={next ? 'secondary' : undefined}
          onClick={() => {
            advanceRequested.current = false;
          }}
        >
          {pending ? '正在保存…' : '保存草稿修订'}
        </button>
        {next ? (
          <button
            disabled={!hydrated || pending}
            type="submit"
            onClick={() => {
              advanceRequested.current = true;
            }}
          >
            {pending ? '正在保存…' : '保存并继续'}
          </button>
        ) : null}
      </div>
    </form>
  );
}
