'use client';
import { BrandMark } from '@h5cs/ui';

import { HumanContactNotice } from './human-contact-notice';

import { Button } from '@h5cs/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  applyTurnResult,
  attachSession,
  beginMessage,
  dismissFailed,
  failPending,
  initialConversationState,
  markAccepted,
  retryPending,
  shouldContinuePolling,
  toConversationView,
  type ConversationState,
} from './conversation-model';
import { pollDelayMilliseconds, shouldSubmitComposerKey } from './interaction-policy';
import { consumerFailure, replyProgress, supportReference } from './consumer-recovery';
import {
  createPublicAssistantApiClient,
  PublicApiClientError,
  type OnlinePublicAssistantSnapshot,
} from './public-api-client';
import {
  clearBrowserSessionReference,
  readBrowserSessionReference,
  saveBrowserSessionReference,
} from './session-reference';

function SendIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path
        d="m4 5 16 7-16 7 3-7-3-7Zm3 7h13"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function clientId(prefix: 'message' | 'session_request'): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function failureDetails(error: unknown): {
  message: string;
  retryable: boolean;
  code?: string | undefined;
  requestId?: string | undefined;
} {
  if (error instanceof PublicApiClientError) {
    return {
      ...consumerFailure(error.code, error.retryable),
      ...(error.kind === 'invalid_response'
        ? { message: '客服资料或连接状态发生变化。请刷新客服状态后再试，原问题仍显示在本页。' }
        : {}),
      code: error.code,
      requestId: error.requestId,
    };
  }
  return consumerFailure(undefined, true);
}

interface OnlineCustomerServiceProps {
  apiBaseUrl: string;
  publicSlug: string;
  snapshot: OnlinePublicAssistantSnapshot;
}

export function OnlineCustomerService({
  apiBaseUrl,
  publicSlug,
  snapshot,
}: OnlineCustomerServiceProps) {
  const [conversation, setConversation] = useState<ConversationState>(initialConversationState);
  const [activeSnapshot, setActiveSnapshot] = useState(snapshot);
  const [draft, setDraft] = useState('');
  const [ending, setEnding] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<'restoring' | 'ready' | 'failed'>('restoring');
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | undefined>(undefined);
  const [previousQuestion, setPreviousQuestion] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ id: string | null; seconds: number }>({
    id: null,
    seconds: 0,
  });
  const sessionRequestIdRef = useRef<string | null>(null);
  const activeController = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const viewMessages = useMemo(
    () => toConversationView(conversation, activeSnapshot.welcomeMessage),
    [conversation, activeSnapshot.welcomeMessage],
  );

  useEffect(() => () => activeController.current?.abort(), []);

  const waitingId =
    conversation.pending && conversation.pending.phase !== 'failed'
      ? conversation.pending.clientMessageId
      : null;
  useEffect(() => {
    if (!waitingId) {
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(
      () => setProgress({ id: waitingId, seconds: Math.floor((Date.now() - started) / 1000) }),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [waitingId]);

  useEffect(() => {
    const controller = new AbortController();
    const sessionRequestId = readBrowserSessionReference(publicSlug);
    if (!sessionRequestId) {
      queueMicrotask(() => {
        if (!controller.signal.aborted) setRestoreStatus('ready');
      });
      return () => controller.abort();
    }
    running.current = true;
    const restore = async () => {
      try {
        const client = createPublicAssistantApiClient({
          apiBaseUrl,
          origin: window.location.origin,
        });
        const session = await client.resumeSession({
          publicSlug,
          sessionRequestId,
          signal: controller.signal,
        });
        if (!session) {
          clearBrowserSessionReference(publicSlug);
          setRecoveryNotice('上次咨询已结束，发送消息将开始新咨询。');
          setRestoreStatus('ready');
          return;
        }
        const history = await client.loadHistory({
          sessionHandle: session.sessionHandle,
          signal: controller.signal,
        });
        if (
          !history ||
          history.session.sessionHandle !== session.sessionHandle ||
          history.session.releaseRef !== session.releaseRef ||
          history.snapshot.publicAssistantId !== publicSlug
        ) {
          clearBrowserSessionReference(publicSlug);
          setRecoveryNotice('上次咨询无法恢复，发送消息将开始新咨询。');
          setRestoreStatus('ready');
          return;
        }
        sessionRequestIdRef.current = sessionRequestId;
        setActiveSnapshot(history.snapshot);
        setConversation({
          session,
          messages: history.messages,
          ...(history.activeTurn
            ? {
                pending: {
                  clientMessageId: history.activeTurn.clientMessageId,
                  content: history.activeTurn.content,
                  sessionRequestId,
                  phase: 'sending' as const,
                  retryable: false,
                },
              }
            : {}),
        });
        if (history.hasEarlierMessages) {
          setRecoveryNotice('已恢复本次咨询，当前仅展示最近 200 条消息。');
        }
        setRestoreStatus('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure = failureDetails(error);
        setRecoveryNotice(
          failure.code === 'RELEASE_WITHDRAWN'
            ? failure.message
            : '暂时未能恢复上次咨询。请重试恢复；不会因此重新发送你的问题。',
        );
        setRecoveryCode(failure.code);
        setRestoreStatus('failed');
      } finally {
        running.current = false;
      }
    };
    void restore();
    return () => controller.abort();
  }, [apiBaseUrl, publicSlug, restoreAttempt]);

  useEffect(() => {
    const pending = conversation.pending;
    if (restoreStatus !== 'ready' || pending?.phase !== 'sending' || running.current) return;
    running.current = true;
    const controller = new AbortController();
    activeController.current?.abort();
    activeController.current = controller;
    let workingState: ConversationState = conversation;

    const execute = async () => {
      try {
        const client = createPublicAssistantApiClient({
          apiBaseUrl,
          origin: window.location.origin,
        });
        const session =
          workingState.session ??
          (await client.createSession({
            publicSlug,
            sessionRequestId: pending.sessionRequestId,
            signal: controller.signal,
            snapshot: activeSnapshot,
          }));
        if (!workingState.session) {
          sessionRequestIdRef.current = pending.sessionRequestId;
          try {
            saveBrowserSessionReference(publicSlug, pending.sessionRequestId);
          } catch {
            // Browser storage is optional for the current conversation.
          }
        }
        workingState = attachSession(workingState, session);
        setConversation(workingState);

        const accepted = await client.sendMessage({
          clientMessageId: pending.clientMessageId,
          content: pending.content,
          sessionHandle: session.sessionHandle,
          signal: controller.signal,
        });
        workingState = markAccepted(workingState, accepted);
        setConversation(workingState);

        try {
          for await (const result of client.streamTurn({
            clientMessageId: pending.clientMessageId,
            eventsUrl: accepted.eventsUrl,
            sessionHandle: session.sessionHandle,
            signal: controller.signal,
            turnId: accepted.turnId,
          })) {
            workingState = applyTurnResult(workingState, result);
            setConversation(workingState);
            if (!shouldContinuePolling(result.state)) return;
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // A dropped or unsupported event stream resumes through the durable result endpoint.
        }

        let completedPolls = 0;
        while (!controller.signal.aborted) {
          const result = await client.readTurn({
            clientMessageId: pending.clientMessageId,
            resultUrl: accepted.resultUrl,
            sessionHandle: session.sessionHandle,
            signal: controller.signal,
            turnId: accepted.turnId,
          });
          workingState = applyTurnResult(workingState, result);
          setConversation(workingState);
          if (!shouldContinuePolling(result.state)) return;
          await wait(pollDelayMilliseconds(completedPolls), controller.signal);
          completedPolls += 1;
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setConversation(failPending(workingState, failureDetails(error)));
      } finally {
        if (activeController.current === controller) activeController.current = undefined;
        running.current = false;
      }
    };
    void execute();
  }, [conversation, restoreStatus, apiBaseUrl, publicSlug, activeSnapshot]);

  function submitMessage(): void {
    const content = draft.trim();
    if (
      restoreStatus !== 'ready' ||
      ending ||
      content.length === 0 ||
      content.length > 2_000 ||
      conversation.pending !== undefined
    )
      return;
    const nextState = beginMessage(conversation, {
      clientMessageId: clientId('message'),
      content,
      sessionRequestId: sessionRequestIdRef.current ?? clientId('session_request'),
    });
    setDraft('');
    setConversation(nextState);
  }

  function retryMessage(): void {
    const nextState = retryPending(conversation);
    if (nextState.pending === undefined || nextState === conversation) return;
    setConversation(nextState);
  }

  function viewLatestAssistant(): void {
    activeController.current?.abort();
    try {
      clearBrowserSessionReference(publicSlug);
    } catch {
      // No message or new session is submitted by this action.
    }
    sessionRequestIdRef.current = null;
    window.location.reload();
  }

  function continueQuestion(): void {
    if (conversation.pending?.phase !== 'failed') return;
    setPreviousQuestion(conversation.pending.content);
    setConversation((current) => dismissFailed(current));
  }

  async function startNewConsultation(): Promise<void> {
    const session = conversation.session;
    if (
      !session ||
      conversation.pending !== undefined ||
      ending ||
      !window.confirm('结束本次咨询并开始新的咨询？当前对话上下文不会带入新咨询。')
    ) {
      return;
    }
    const controller = new AbortController();
    activeController.current = controller;
    setEnding(true);
    try {
      const client = createPublicAssistantApiClient({
        apiBaseUrl,
        origin: window.location.origin,
      });
      await client.endSession({ sessionHandle: session.sessionHandle, signal: controller.signal });
      try {
        clearBrowserSessionReference(publicSlug);
      } catch {
        // Browser storage is optional; reloading still starts a fresh consultation.
      }
      sessionRequestIdRef.current = null;
      window.location.reload();
    } catch (error) {
      if (!controller.signal.aborted) setRecoveryNotice(failureDetails(error).message);
    } finally {
      if (activeController.current === controller) activeController.current = undefined;
      setEnding(false);
    }
  }

  const pending = conversation.pending;
  const inputDisabled = restoreStatus !== 'ready' || pending !== undefined || ending;
  const releaseWithdrawn =
    pending?.errorCode === 'RELEASE_WITHDRAWN' || recoveryCode === 'RELEASE_WITHDRAWN';
  const earlierVersion =
    conversation.session !== undefined && activeSnapshot.releaseRef !== snapshot.releaseRef;

  return (
    <main className="consumer-page">
      <section aria-label="AI 客服咨询窗口" className="chat-shell chat-shell--online">
        <header className="chat-header">
          <div className="assistant-identity">
            <div aria-hidden="true" className="assistant-avatar">
              <BrandMark />
            </div>
            <div>
              <div className="assistant-title-row">
                <h1>{activeSnapshot.assistantDisplayName}</h1>
                <span className="ai-label">AI</span>
              </div>
              <p>{activeSnapshot.merchantDisplayName} · 在线</p>
            </div>
          </div>
          {conversation.session ? (
            <button
              data-usage="conversation.new"
              className="new-consultation-button"
              disabled={pending !== undefined || ending}
              onClick={() => void startNewConsultation()}
              type="button"
            >
              {ending ? '正在结束…' : '新建咨询'}
            </button>
          ) : null}
        </header>

        <div className="conversation-notices">
          <p className="version-notice">
            本商家只有一个AI客服，你的咨询上下文独立保存。在有效期内可在此浏览器继续咨询，换设备不会自动关联。
          </p>
          <aside className="scope-notice">
            <strong>这是 AI 客服</strong>
            <span>
              {releaseWithdrawn ? '此前资料已撤回，请查看最新客服。' : activeSnapshot.businessScope}
            </span>
          </aside>
          {conversation.session ? (
            <aside className="version-notice" role="status">
              {releaseWithdrawn
                ? '本次咨询已结束。历史消息仅供回顾，不代表商家当前资料。'
                : earlierVersion
                  ? '商家资料已有新版。本次咨询仍使用开始时的资料；如需最新资料，请新建咨询。'
                  : '本次咨询使用开始时的资料；商家更新后，新建咨询才会使用新版。'}
            </aside>
          ) : null}
          <HumanContactNotice
            instructions={releaseWithdrawn ? undefined : activeSnapshot.humanContact}
          />
        </div>

        <div
          aria-busy={pending?.phase === 'sending' || pending?.phase === 'waiting'}
          aria-label="咨询消息"
          aria-live="polite"
          className="message-list"
          role="log"
        >
          <p className="timeline-label">本次咨询</p>
          {viewMessages.map((message) => (
            <article className={`message-row message-row--${message.role}`} key={message.key}>
              {message.role === 'assistant' ? (
                <div aria-hidden="true" className="message-avatar">
                  AI
                </div>
              ) : null}
              <div className="message-content">
                <div className="message-bubble">
                  <p>{message.content}</p>
                </div>
                {message.status !== undefined || message.role === 'assistant' ? (
                  <p className={`message-status${message.status === 'failed' ? ' is-failed' : ''}`}>
                    {message.status === 'sending' ? '发送中…' : null}
                    {message.status === 'waiting' ? 'AI 正在整理回答…' : null}
                    {message.status === 'failed' ? '本次回复未完成，问题已保留' : null}
                    {message.status === undefined ? (message.sourceLabel ?? 'AI 客服') : null}
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        <footer className="composer-area">
          {pending && pending.phase !== 'failed' ? (
            <p className="reply-progress" role="status">
              {replyProgress(
                pending.phase,
                progress.id === pending.clientMessageId ? progress.seconds : 0,
              )}
            </p>
          ) : null}
          {restoreStatus === 'restoring' ? <p role="status">正在恢复上次咨询…</p> : null}
          {recoveryNotice ? <p role="status">{recoveryNotice}</p> : null}
          {restoreStatus === 'failed' && !releaseWithdrawn ? (
            <button
              onClick={() => {
                setRecoveryNotice(null);
                setRecoveryCode(undefined);
                setRestoreStatus('restoring');
                setRestoreAttempt((value) => value + 1);
              }}
              type="button"
            >
              重试恢复上次咨询
            </button>
          ) : null}
          {releaseWithdrawn ? (
            <div className="send-failure" role="alert">
              <p>{consumerFailure('RELEASE_WITHDRAWN', false).message}</p>
              <button onClick={viewLatestAssistant} type="button">
                查看最新客服
              </button>
              <p>不会自动重发旧问题；商家尚未重新发布时，最新页面仍会显示服务未开放。</p>
            </div>
          ) : null}
          {pending?.phase === 'failed' && !releaseWithdrawn ? (
            <div className="send-failure" role="alert">
              <p>{pending.errorMessage}</p>
              <div>
                {pending.retryable ? (
                  <button onClick={retryMessage} type="button">
                    重试回复
                  </button>
                ) : null}
                <button onClick={continueQuestion} type="button">
                  继续提问
                </button>
                <button onClick={() => window.location.reload()} type="button">
                  刷新客服状态
                </button>
              </div>
              <p>重试会继续确认同一条问题，不会作为新问题重复提交。</p>
              {supportReference(pending.requestId ?? pending.turn?.traceId) ? (
                <p>支持编号：{supportReference(pending.requestId ?? pending.turn?.traceId)}</p>
              ) : null}
            </div>
          ) : null}
          {previousQuestion ? (
            <details className="previous-question">
              <summary>上次未完成的问题（仅保留在本页）</summary>
              <p>{previousQuestion}</p>
              <p>继续输入不会自动重发上面的问题。</p>
            </details>
          ) : null}
          <form
            data-usage="conversation.send"
            aria-label="发送咨询消息"
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submitMessage();
            }}
          >
            <label className="visually-hidden" htmlFor="message-input">
              输入想咨询的问题
            </label>
            <textarea
              aria-describedby="composer-help"
              disabled={inputDisabled}
              id="message-input"
              maxLength={2_000}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  shouldSubmitComposerKey({
                    ctrlKey: event.ctrlKey,
                    isComposing: event.nativeEvent.isComposing,
                    key: event.key,
                    metaKey: event.metaKey,
                  })
                ) {
                  event.preventDefault();
                  submitMessage();
                }
              }}
              placeholder={inputDisabled ? '请等待当前消息处理完成' : '输入想咨询的问题'}
              rows={1}
              value={draft}
            />
            <Button
              aria-label="发送消息"
              busy={pending?.phase === 'sending'}
              disabled={inputDisabled || draft.trim().length === 0}
              type="submit"
            >
              <SendIcon />
            </Button>
          </form>
          <p id="composer-help" className="composer-help">
            Ctrl/Cmd + Enter 发送。AI 回复仅供业务咨询参考；不确定时请联系商家核实。
          </p>
        </footer>
      </section>
    </main>
  );
}
