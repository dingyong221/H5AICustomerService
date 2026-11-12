import type { AcceptedTurn, PublicMessage, PublicSession, TurnResult } from './public-api-client';
import { consumerFailure } from './consumer-recovery';

export type PendingMessage = Readonly<{
  clientMessageId: string;
  content: string;
  errorMessage?: string | undefined;
  errorCode?: string | undefined;
  requestId?: string | undefined;
  phase: 'sending' | 'waiting' | 'failed';
  retryable: boolean;
  sessionRequestId: string;
  turn?: AcceptedTurn | undefined;
}>;

export type ConversationState = Readonly<{
  messages: readonly PublicMessage[];
  pending?: PendingMessage | undefined;
  session?: PublicSession | undefined;
}>;

export type ConversationViewMessage = Readonly<{
  content: string;
  key: string;
  role: 'visitor' | 'assistant';
  sourceLabel?: string | undefined;
  status?: 'sending' | 'waiting' | 'failed' | undefined;
}>;

export const initialConversationState: ConversationState = { messages: [] };

export function shouldContinuePolling(state: TurnResult['state']): boolean {
  return state === 'accepted' || state === 'processing';
}

function sameMessage(left: PublicMessage, right: PublicMessage): boolean {
  return (
    left.clientMessageId === right.clientMessageId &&
    left.content === right.content &&
    left.createdAt === right.createdAt &&
    left.messageId === right.messageId &&
    left.role === right.role &&
    left.sequence === right.sequence &&
    left.sourceLabel === right.sourceLabel
  );
}

export function mergeOrderedMessages(
  current: readonly PublicMessage[],
  incoming: readonly PublicMessage[],
): readonly PublicMessage[] {
  const byId = new Map(current.map((message) => [message.messageId, message]));
  const bySequence = new Map(current.map((message) => [message.sequence, message]));
  const visitorClientIds = new Map(
    current.flatMap((message) =>
      message.role === 'visitor' && message.clientMessageId !== undefined
        ? [[message.clientMessageId, message] as const]
        : [],
    ),
  );

  for (const message of incoming) {
    const existingById = byId.get(message.messageId);
    if (existingById !== undefined) {
      if (!sameMessage(existingById, message)) {
        throw new Error('服务端返回了冲突的消息。');
      }
      continue;
    }
    const existingBySequence = bySequence.get(message.sequence);
    if (existingBySequence !== undefined) {
      throw new Error('服务端返回了冲突的消息顺序。');
    }
    if (message.role === 'visitor' && message.clientMessageId !== undefined) {
      const existingByClientId = visitorClientIds.get(message.clientMessageId);
      if (existingByClientId !== undefined) {
        throw new Error('服务端返回了重复的访客消息。');
      }
      visitorClientIds.set(message.clientMessageId, message);
    }
    byId.set(message.messageId, message);
    bySequence.set(message.sequence, message);
  }

  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

export function beginMessage(
  state: ConversationState,
  input: { clientMessageId: string; content: string; sessionRequestId: string },
): ConversationState {
  if (state.pending !== undefined && state.pending.phase !== 'failed') {
    throw new Error('上一条消息仍在处理中。');
  }
  return {
    ...state,
    pending: {
      ...input,
      phase: 'sending',
      retryable: false,
    },
  };
}

export function attachSession(state: ConversationState, session: PublicSession): ConversationState {
  if (state.session !== undefined && state.session.sessionHandle !== session.sessionHandle) {
    throw new Error('会话标识发生冲突。');
  }
  return { ...state, session };
}

export function markAccepted(state: ConversationState, accepted: AcceptedTurn): ConversationState {
  if (state.pending === undefined) throw new Error('没有待处理消息。');
  return {
    ...state,
    pending: {
      ...state.pending,
      phase: 'waiting',
      retryable: false,
      turn: accepted,
    },
  };
}

export function applyTurnResult(state: ConversationState, result: TurnResult): ConversationState {
  if (
    state.pending === undefined ||
    state.session === undefined ||
    state.pending.turn === undefined ||
    state.session.sessionHandle !== result.sessionHandle ||
    state.pending.turn.turnId !== result.turnId ||
    state.pending.turn.traceId !== result.traceId
  ) {
    throw new Error('消息结果与当前会话不匹配。');
  }
  const messages = mergeOrderedMessages(state.messages, result.messages);
  if (result.state === 'completed') return { messages, session: state.session };
  if (result.state === 'failed') {
    const failure = consumerFailure(result.error.code, result.error.retryable);
    return {
      messages,
      pending: {
        ...state.pending,
        errorMessage:
          result.error.code === 'MARKETPLACE_QUOTA_EXHAUSTED'
            ? '商家的AI服务额度已用尽，请联系商家。'
            : result.error.code === 'MARKETPLACE_NOT_ELIGIBLE'
              ? '商家的AI服务已暂停或过期，请联系商家。'
              : failure.message,
        errorCode: result.error.code,
        phase: 'failed',
        retryable: failure.retryable,
      },
      session: state.session,
    };
  }
  return { ...state, messages };
}

export function failPending(
  state: ConversationState,
  input: {
    message: string;
    retryable: boolean;
    code?: string | undefined;
    requestId?: string | undefined;
  },
): ConversationState {
  if (state.pending === undefined) return state;
  return {
    ...state,
    pending: {
      ...state.pending,
      errorMessage: input.message,
      errorCode: input.code,
      requestId: input.requestId,
      phase: 'failed',
      retryable: input.retryable,
    },
  };
}

export function retryPending(state: ConversationState): ConversationState {
  if (
    state.pending?.phase !== 'failed' ||
    !state.pending.retryable ||
    state.pending.errorCode === 'MODEL_RESULT_UNKNOWN'
  )
    return state;
  return {
    ...state,
    pending: {
      clientMessageId: state.pending.clientMessageId,
      content: state.pending.content,
      phase: 'sending',
      retryable: false,
      sessionRequestId: state.pending.sessionRequestId,
    },
  };
}

export function dismissFailed(state: ConversationState): ConversationState {
  if (state.pending?.phase !== 'failed') return state;
  return state.session === undefined
    ? { messages: state.messages }
    : { messages: state.messages, session: state.session };
}

export function toConversationView(
  state: ConversationState,
  welcomeMessage: string,
): readonly ConversationViewMessage[] {
  const messages: ConversationViewMessage[] = [
    {
      content: welcomeMessage,
      key: 'trusted-welcome',
      role: 'assistant',
      sourceLabel: 'AI 客服',
    },
    ...state.messages.map((message) => {
      const isCurrentVisitorMessage =
        message.role === 'visitor' &&
        state.pending !== undefined &&
        message.clientMessageId === state.pending.clientMessageId;
      return {
        content: message.content,
        key: message.messageId,
        role: message.role,
        ...(message.sourceLabel === undefined ? {} : { sourceLabel: message.sourceLabel }),
        ...(isCurrentVisitorMessage ? { status: state.pending.phase } : {}),
      };
    }),
  ];
  const pending = state.pending;
  const alreadyConfirmed =
    pending === undefined
      ? false
      : state.messages.some(
          (message) =>
            message.role === 'visitor' && message.clientMessageId === pending.clientMessageId,
        );
  if (pending !== undefined && !alreadyConfirmed) {
    messages.push({
      content: pending.content,
      key: `pending-${pending.clientMessageId}`,
      role: 'visitor',
      status: pending.phase,
    });
  }
  return messages;
}
