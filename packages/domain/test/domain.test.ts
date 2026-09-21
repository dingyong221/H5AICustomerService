import { describe, expect, it } from 'vitest';

import {
  ActiveTurnMismatchError,
  InvalidReleaseTransitionError,
  TenantScopeMismatchError,
  TurnInProgressError,
  assertAssistantScope,
  assertReleaseTransition,
  beginSessionTurn,
  completeSessionTurn,
  failSessionTurn,
  toAssistantId,
  toMerchantId,
  toTurnId,
} from '../src/index.js';

describe('release state rules', () => {
  it('allows activation and rollback through explicit transitions', () => {
    expect(() => assertReleaseTransition('ready', 'active')).not.toThrow();
    expect(() => assertReleaseTransition('retired', 'active')).not.toThrow();
  });

  it('rejects skipping release validation', () => {
    expect(() => assertReleaseTransition('validating', 'active')).toThrow(
      InvalidReleaseTransitionError,
    );
  });
});

describe('tenant scope rules', () => {
  it('rejects an assistant from another merchant', () => {
    expect(() =>
      assertAssistantScope(
        { merchantId: toMerchantId('merchant-1'), assistantId: toAssistantId('assistant-1') },
        { merchantId: toMerchantId('merchant-2'), assistantId: toAssistantId('assistant-1') },
      ),
    ).toThrow(TenantScopeMismatchError);
  });
});

describe('single-active-turn session rules', () => {
  it('allocates ordered user and assistant message sequences', () => {
    const turnId = toTurnId('turn-1');
    const begun = beginSessionTurn({ activeTurnId: null, nextMessageSequence: 1 }, turnId);
    const completed = completeSessionTurn(begun.state, turnId);

    expect(begun.userMessageSequence).toBe(1);
    expect(completed.assistantMessageSequence).toBe(2);
    expect(completed.state).toEqual({ activeTurnId: null, nextMessageSequence: 3 });
  });

  it('rejects a second active turn and preserves sequence on failure', () => {
    const first = toTurnId('turn-1');
    const second = toTurnId('turn-2');
    const begun = beginSessionTurn({ activeTurnId: null, nextMessageSequence: 7 }, first);

    expect(() => beginSessionTurn(begun.state, second)).toThrow(TurnInProgressError);
    expect(() => completeSessionTurn(begun.state, second)).toThrow(ActiveTurnMismatchError);
    expect(failSessionTurn(begun.state, first)).toEqual({
      activeTurnId: null,
      nextMessageSequence: 8,
    });
  });
});
