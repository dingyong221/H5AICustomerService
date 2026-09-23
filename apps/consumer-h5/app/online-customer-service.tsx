'use client';

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
import {
  createPublicAssistantApiClient,
  PublicApiClientError,
  type OnlinePublicAssistantSnapshot,
} from './public-api-client';
import {
  clearSessionReference,
  readSessionReference,
  saveSessionReference,
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

function failureDetails(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof PublicApiClientError) {
    return { message: error.message, retryable: error.retryable };
  }
  return { message: '未能确认服务端状态，请稍后重试。', retryable: true };
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
  const sessionRequestIdRef = useRef<string | null>(null);
  const activeController = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  const viewMessages = useMemo(
    () => toConversationView(conversation, activeSnapshot.welcomeMessage),
    [conversation, activeSnapshot.welcomeMessage],
  );

  useEffect(() => () => activeController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    let storage: Storage;
    try {
      storage = window.sessionStorage;
    } catch {
      queueMicrotask(() => {
        if (!controller.signal.aborted) setRestoreStatus('ready');
      });
      return () => controller.abort();
    }
    const sessionRequestId = readSessionReference(storage, publicSlug);
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
          clearSessionReference(storage, publicSlug);
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
          clearSessionReference(storage, publicSlug);
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
        setRecoveryNotice(
          error instanceof PublicApiClientError ? error.message : '暂时无法恢复咨询，请重试。',
        );
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
            saveSessionReference(window.sessionStorage, publicSlug, pending.sessionRequestId);
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
        clearSessionReference(window.sessionStorage, publicSlug);
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

  return (
    <main className="consumer-page">
      <section aria-label="AI 客服咨询窗口" className="chat-shell chat-shell--online">
        <header className="chat-header">
          <div className="assistant-identity">
            <div aria-hidden="true" className="assistant-avatar">
              AI
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
              className="new-consultation-button"
              disabled={pending !== undefined || ending}
              onClick={() => void startNewConsultation()}
              type="button"
            >
              {ending ? '正在结束…' : '新建咨询'}
            </button>
          ) : null}
        </header>

        <aside className="scope-notice">
          <strong>这是 AI 客服</strong>
          <span>{activeSnapshot.businessScope}</span>
        </aside>

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
                    {message.status === 'waiting' ? '已发送，等待 AI 回复…' : null}
                    {message.status === 'failed' ? '发送或回复失败' : null}
                    {message.status === undefined ? (message.sourceLabel ?? 'AI 客服') : null}
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </div>

        <footer className="composer-area">
          {restoreStatus === 'restoring' ? <p role="status">正在恢复上次咨询…</p> : null}
          {recoveryNotice ? <p role="status">{recoveryNotice}</p> : null}
          {restoreStatus === 'failed' ? (
            <button
              onClick={() => {
                setRecoveryNotice(null);
                setRestoreStatus('restoring');
                setRestoreAttempt((value) => value + 1);
              }}
              type="button"
            >
              重试恢复上次咨询
            </button>
          ) : null}
          {pending?.phase === 'failed' ? (
            <div className="send-failure" role="alert">
              <p>{pending.errorMessage}</p>
              <div>
                {pending.retryable ? (
                  <button onClick={retryMessage} type="button">
                    使用同一消息编号重试
                  </button>
                ) : null}
                <button
                  onClick={() => setConversation((current) => dismissFailed(current))}
                  type="button"
                >
                  结束本条
                </button>
              </div>
            </div>
          ) : null}
          <form
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
