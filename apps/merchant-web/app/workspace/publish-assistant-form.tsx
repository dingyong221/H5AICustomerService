'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

import { ShareAssistantLink } from '../share-assistant-link';
import { confirmAndPublishAssistantAction } from './publish-actions';

export function PublishAssistantForm({
  merchantId,
  assistantId,
  draftRevision,
  csrfToken,
  idempotencyKey,
  ready,
  reason,
  consumerOrigin,
  hasPublishedLink = false,
}: {
  merchantId: string;
  assistantId: string;
  draftRevision: number;
  csrfToken: string;
  idempotencyKey: string;
  ready: boolean;
  reason: string | null;
  consumerOrigin: string | null;
  hasPublishedLink?: boolean;
}) {
  const [state, action, pending] = useActionState(confirmAndPublishAssistantAction, {
    error: null,
    published: false,
    publicUrl: null,
    releaseNo: null,
  });
  const router = useRouter();
  const refreshed = useRef(false);
  const revealedLink = useRef(false);
  useEffect(() => {
    if (state.published && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [state.published, router]);
  useEffect(() => {
    if (!state.published || !hasPublishedLink || revealedLink.current) return;
    const linkCard = document.getElementById('consumer-link');
    if (!linkCard) return;
    revealedLink.current = true;
    linkCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    linkCard.focus({ preventScroll: true });
  }, [state.published, hasPublishedLink]);
  const canPublish = ready && csrfToken.length > 0;
  return (
    <form action={action} className="assistant-confirm-form">
      <input name="merchantId" type="hidden" value={merchantId} />
      <input name="assistantId" type="hidden" value={assistantId} />
      <input name="draftRevision" type="hidden" value={draftRevision} />
      <input name="csrfToken" type="hidden" value={csrfToken} />
      <input name="idempotencyKey" type="hidden" value={idempotencyKey} />
      <p>
        勾选表示你已核对草稿修订 {draftRevision}。提交后会确认资料并实际发布 AI
        客服，提供固定消费者链接。服务端会再次检查本修订试聊判定和业务事实；修改资料后必须重新试聊。
        新咨询使用本次内容，现有会话继续使用建立时的版本；后续发布新版不更换链接。
      </p>
      <label>
        <input
          disabled={!canPublish || state.published}
          name="confirmAndPublish"
          required
          type="checkbox"
          value="yes"
        />
        我已核对以上资料，并确认向消费者公开发布当前修订。
      </label>
      {!ready && reason ? <p role="status">{reason}</p> : null}
      {ready && !csrfToken ? <p role="status">安全校验信息缺失，请重新登录。</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {state.published ? (
        <div role="status">
          <p>第 {state.releaseNo} 版已发布。消费者始终使用同一个固定链接，无需反复发送新地址。</p>
          {state.publicUrl && consumerOrigin && !hasPublishedLink ? (
            <ShareAssistantLink expectedOrigin={consumerOrigin} href={state.publicUrl} />
          ) : null}
        </div>
      ) : null}
      <button disabled={!canPublish || state.published || pending} type="submit">
        {pending ? '正在确认资料并发布…' : '确认资料并发布 AI 客服'}
      </button>
    </form>
  );
}
