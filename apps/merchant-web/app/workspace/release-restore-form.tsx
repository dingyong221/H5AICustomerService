'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { merchantPath } from '../tenant-paths';
import { restoreReleaseToDraftAction } from './release-history-actions';

export function ReleaseRestoreForm({
  merchantId,
  assistantId,
  releaseId,
  releaseNo,
  draftRevision,
  csrfToken,
}: {
  merchantId: string;
  assistantId: string;
  releaseId: string;
  releaseNo: number;
  draftRevision: number;
  csrfToken: string;
}) {
  const [state, action, pending] = useActionState(restoreReleaseToDraftAction, {
    error: null,
    restored: null,
  });
  return (
    <form action={action} className="release-restore-form">
      <input type="hidden" name="merchantId" value={merchantId} />
      <input type="hidden" name="assistantId" value={assistantId} />
      <input type="hidden" name="releaseId" value={releaseId} />
      <input type="hidden" name="draftRevision" value={draftRevision} />
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <p>恢复只替换当前未发布草稿的业务文字，不改变客服名称、消费者固定链接或上传材料列表。</p>
      <p>历史版本可能包含后来已修正的问题。请重新核对并试聊；当前消费者版本不会立即改变。</p>
      <fieldset
        className="draft-form-fields"
        disabled={pending || state.restored !== null || !csrfToken}
      >
        <label className="release-restore-consent">
          <input type="checkbox" name="restoreConfirmed" value="yes" required />
          我确认用第 {releaseNo} 版业务资料替换当前草稿，并重新核对、试聊后再发布。
        </label>
        <button type="submit">{pending ? '正在恢复…' : '恢复为待核对草稿'}</button>
      </fieldset>
      {state.error ? <p role="alert">{state.error}</p> : null}
      {!csrfToken && !state.restored ? (
        <p role="alert">安全校验已失效，请重新登录后恢复资料。</p>
      ) : null}
      {state.restored ? (
        <p role="status">
          已从第 {state.restored.sourceReleaseNo} 版恢复为草稿修订 {state.restored.draftRevision}
          ，当前消费者版本未改变。
          <Link href={merchantPath(merchantId, 'drafts', assistantId)}>核对资料并继续</Link>
        </p>
      ) : null}
    </form>
  );
}
