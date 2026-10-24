import { describe, expect, it } from 'vitest';

import {
  applyTurnResult,
  attachSession,
  beginMessage,
  dismissFailed,
  failPending,
  initialConversationState,
  markAccepted,
  mergeOrderedMessages,
  retryPending,
  shouldContinuePolling,
  toConversationView,
} from './conversation-model';
import type { AcceptedTurn, PublicMessage, PublicSession } from './public-api-client';

const session: PublicSession = {
  createdAt: '2026-09-21T08:00:00.000Z',
  releaseRef: 'release_1234567890',
  sessionHandle: 'session_1234567890',
  state: 'active',
};

const accepted: AcceptedTurn = {
  eventsUrl: 'https://h5.example.com/api/v1/public/turns/turn_1234567890/events',
  resultUrl: 'https://h5.example.com/api/v1/public/turns/turn_1234567890',
  state: 'accepted',
  traceId: 'trace_1234567890',
  turnId: 'turn_1234567890',
};

const visitorMessage: PublicMessage = {
  clientMessageId: 'message_client_1234567890',
  content: '多久发货？',
  createdAt: '2026-09-21T08:00:01.000Z',
  messageId: 'server_message_1',
  role: 'visitor',
  sequence: 1,
};

const assistantMessage: PublicMessage = {
  content: '通常会在两个工作日内发货。',
  createdAt: '2026-09-21T08:00:02.000Z',
  messageId: 'server_message_2',
  role: 'assistant',
  sequence: 2,
  sourceLabel: 'AI 客服',
};

function pendingState() {
  return beginMessage(initialConversationState, {
    clientMessageId: 'message_client_1234567890',
    content: '多久发货？',
    sessionRequestId: 'session_request_1234567890',
  });
}

describe('conversation model', () => {
  it('continues polling for accepted and processing turns only', () => {
    expect(shouldContinuePolling('accepted')).toBe(true);
    expect(shouldContinuePolling('processing')).toBe(true);
    expect(shouldContinuePolling('completed')).toBe(false);
    expect(shouldContinuePolling('failed')).toBe(false);
  });

  it('orders confirmed messages by the server sequence', () => {
    expect(mergeOrderedMessages([assistantMessage], [visitorMessage])).toEqual([
      visitorMessage,
      assistantMessage,
    ]);
  });

  it('rejects conflicting server sequence assignments', () => {
    expect(() =>
      mergeOrderedMessages(
        [visitorMessage],
        [{ ...assistantMessage, sequence: visitorMessage.sequence }],
      ),
    ).toThrow('消息顺序');
  });

  it('retries with the same client message and session identifiers', () => {
    const failed = failPending(pendingState(), { message: '网络错误', retryable: true });
    const retried = retryPending(failed);
    expect(retried.pending).toMatchObject({
      clientMessageId: 'message_client_1234567890',
      content: '多久发货？',
      phase: 'sending',
      sessionRequestId: 'session_request_1234567890',
    });
  });

  it('shows only a local visitor pending bubble and never invents an assistant reply', () => {
    const view = toConversationView(pendingState(), '欢迎咨询');
    expect(view).toEqual([
      {
        content: '欢迎咨询',
        key: 'trusted-welcome',
        role: 'assistant',
        sourceLabel: 'AI 客服',
      },
      {
        content: '多久发货？',
        key: 'pending-message_client_1234567890',
        role: 'visitor',
        status: 'sending',
      },
    ]);
  });

  it('settles only from a matching server turn result', () => {
    let state = attachSession(pendingState(), session);
    state = markAccepted(state, accepted);
    state = applyTurnResult(state, {
      messages: [visitorMessage, assistantMessage],
      sessionHandle: session.sessionHandle,
      state: 'completed',
      traceId: accepted.traceId,
      turnId: accepted.turnId,
    });
    expect(state.pending).toBeUndefined();
    expect(state.messages).toEqual([visitorMessage, assistantMessage]);
  });

  it('keeps withdrawn questions visible, refuses retry and never migrates the session', () => {
    let state = markAccepted(attachSession(pendingState(), session), accepted);
    state = applyTurnResult(state, {
      messages: [visitorMessage],
      sessionHandle: session.sessionHandle,
      state: 'failed',
      traceId: accepted.traceId,
      turnId: accepted.turnId,
      error: { code: 'RELEASE_WITHDRAWN', retryable: true },
    });
    expect(state.pending).toMatchObject({
      content: '多久发货？',
      errorCode: 'RELEASE_WITHDRAWN',
      retryable: false,
    });
    expect(state.pending?.errorMessage).toContain('商家已撤回');
    expect(retryPending(state)).toBe(state);
    expect(state.session).toBe(session);
    expect(state.messages).toEqual([visitorMessage]);
  });

  it('dismisses a failed item without submitting it or changing any session identity', () => {
    const state = failPending(attachSession(pendingState(), session), {
      message: '请稍后重试',
      retryable: true,
      requestId: 'request_1234567890',
    });
    const continued = dismissFailed(state);
    expect(continued.pending).toBeUndefined();
    expect(continued.session).toBe(session);
    expect(continued.messages).toEqual([]);
  });
});
