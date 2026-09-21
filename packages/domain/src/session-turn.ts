import type { TurnId } from './ids.js';

export type SessionTurnState = Readonly<{
  activeTurnId: TurnId | null;
  nextMessageSequence: number;
}>;

export type BegunTurn = Readonly<{
  state: SessionTurnState;
  userMessageSequence: number;
}>;

export type CompletedTurn = Readonly<{
  state: SessionTurnState;
  assistantMessageSequence: number;
}>;

export class TurnInProgressError extends Error {
  public constructor() {
    super('The session already has an active turn');
    this.name = 'TurnInProgressError';
  }
}

export class ActiveTurnMismatchError extends Error {
  public constructor() {
    super('The requested turn is not the active session turn');
    this.name = 'ActiveTurnMismatchError';
  }
}

const assertValidSequence = (sequence: number): void => {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('nextMessageSequence must be a positive safe integer');
  }
};

export const beginSessionTurn = (state: SessionTurnState, turnId: TurnId): BegunTurn => {
  assertValidSequence(state.nextMessageSequence);
  if (state.activeTurnId !== null) {
    throw new TurnInProgressError();
  }

  return {
    userMessageSequence: state.nextMessageSequence,
    state: {
      activeTurnId: turnId,
      nextMessageSequence: state.nextMessageSequence + 1,
    },
  };
};

export const completeSessionTurn = (state: SessionTurnState, turnId: TurnId): CompletedTurn => {
  assertValidSequence(state.nextMessageSequence);
  if (state.activeTurnId !== turnId) {
    throw new ActiveTurnMismatchError();
  }

  return {
    assistantMessageSequence: state.nextMessageSequence,
    state: {
      activeTurnId: null,
      nextMessageSequence: state.nextMessageSequence + 1,
    },
  };
};

export const failSessionTurn = (state: SessionTurnState, turnId: TurnId): SessionTurnState => {
  assertValidSequence(state.nextMessageSequence);
  if (state.activeTurnId !== turnId) {
    throw new ActiveTurnMismatchError();
  }

  return {
    activeTurnId: null,
    nextMessageSequence: state.nextMessageSequence,
  };
};
