import { describe, expect, it } from 'vitest';

import { draftRevisionStatus } from './draft-revision-status';

describe('persisted draft revision feedback', () => {
  it('does not infer a successful save from an unchanged, older or invalid revision', () => {
    for (const [opened, current] of [
      [2, 2],
      [2, 1],
      [0, 1],
      [1, Number.NaN],
    ])
      expect(draftRevisionStatus(opened!, current!, false)).toBeNull();
  });

  it('explains a server-confirmed new revision and its invalidated confirmation', () => {
    expect(draftRevisionStatus(2, 3, false)).toBe(
      '草稿已保存至修订 3，原有资料确认已失效。请核对新内容后重新确认。',
    );
  });

  it('does not claim confirmation is invalid after the new revision is confirmed', () => {
    expect(draftRevisionStatus(2, 3, true)).toBe('草稿已更新至修订 3，当前资料已确认。');
  });
});
