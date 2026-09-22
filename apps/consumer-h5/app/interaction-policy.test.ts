import { describe, expect, it } from 'vitest';

import { pollDelayMilliseconds, shouldSubmitComposerKey } from './interaction-policy';

describe('consumer interaction policy', () => {
  it('keeps polling indefinitely with a bounded backoff rather than an attempt cutoff', () => {
    expect(pollDelayMilliseconds(0)).toBe(1_000);
    expect(pollDelayMilliseconds(10)).toBe(2_000);
    expect(pollDelayMilliseconds(20)).toBe(4_000);
    expect(pollDelayMilliseconds(1_000)).toBe(5_000);
  });

  it('submits from a multiline composer only on Ctrl/Cmd+Enter outside IME composition', () => {
    expect(
      shouldSubmitComposerKey({ ctrlKey: true, isComposing: false, key: 'Enter', metaKey: false }),
    ).toBe(true);
    expect(
      shouldSubmitComposerKey({ ctrlKey: false, isComposing: false, key: 'Enter', metaKey: true }),
    ).toBe(true);
    expect(
      shouldSubmitComposerKey({ ctrlKey: false, isComposing: false, key: 'Enter', metaKey: false }),
    ).toBe(false);
    expect(
      shouldSubmitComposerKey({ ctrlKey: true, isComposing: true, key: 'Enter', metaKey: false }),
    ).toBe(false);
  });
});
