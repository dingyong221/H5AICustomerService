import { describe, expect, it } from 'vitest';

import {
  consumeWorkBuddyAuthorizationQuery,
  parseWorkBuddyAuthorizationQuery,
} from './authorization-query';

const transactionRef = 'a'.repeat(64);

describe('WorkBuddy authorization query boundary', () => {
  it('uses an exact transaction reference only as a status pointer', () => {
    expect(parseWorkBuddyAuthorizationQuery(`?transaction_ref=${transactionRef}`)).toEqual({
      intent: { kind: 'status', transactionRef },
      untrustedParametersPresent: true,
    });
  });

  it('forwards an exact callback pair for one-time server verification', () => {
    expect(parseWorkBuddyAuthorizationQuery(`?code=one-time-code&state=${'s'.repeat(32)}`)).toEqual(
      {
        intent: { code: 'one-time-code', kind: 'callback', state: 's'.repeat(32) },
        untrustedParametersPresent: true,
      },
    );
  });

  it('removes callback code and state from history before returning the callback intent', () => {
    const replacements: string[] = [];
    const consumed = consumeWorkBuddyAuthorizationQuery({
      href: `https://merchant.example.com/auth/workbuddy/bind?code=one-time-code&state=${'s'.repeat(32)}#binding`,
      replaceUrl: (url) => replacements.push(url),
    });

    expect(consumed.intent).toMatchObject({ kind: 'callback' });
    expect(replacements).toEqual(['/auth/workbuddy/bind#binding']);
    expect(replacements[0]).not.toContain('code');
    expect(replacements[0]).not.toContain('state');
  });

  it('also removes malformed or partial callback material without submitting it', () => {
    const replacements: string[] = [];
    const consumed = consumeWorkBuddyAuthorizationQuery({
      href: 'https://merchant.example.com/auth/workbuddy/bind?code=partial&open_id=untrusted',
      replaceUrl: (url) => replacements.push(url),
    });

    expect(consumed.intent).toEqual({ kind: 'status' });
    expect(replacements).toEqual(['/auth/workbuddy/bind']);
  });

  it('ignores identity claims, partial callbacks, extra fields, and malformed refs', () => {
    for (const search of [
      '?open_id=caller-controlled',
      '?status=connected',
      '?code=one-time-code',
      `?code=one-time-code&state=${'s'.repeat(32)}&open_id=caller-controlled`,
      '?transaction_ref=not-a-valid-ref',
      `?transaction_ref=${transactionRef}&transaction_ref=${'b'.repeat(64)}`,
    ]) {
      expect(parseWorkBuddyAuthorizationQuery(search)).toEqual({
        intent: { kind: 'status' },
        untrustedParametersPresent: true,
      });
    }
  });
});
