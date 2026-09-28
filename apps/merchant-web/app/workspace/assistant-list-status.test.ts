import { describe, expect, it } from 'vitest';

import { assistantListStatus } from './assistant-list-status';

describe('merchant assistant list status', () => {
  it('does not label an existing release as unpublished after the draft changes', () => {
    expect(
      assistantListStatus({
        activeReleaseId: 'release_1',
        knowledgeConfirmed: false,
        status: 'active',
      }),
    ).toBe('已有发布版本；当前草稿资料待确认');
  });

  it('distinguishes paused and never-published assistants', () => {
    expect(
      assistantListStatus({
        activeReleaseId: 'release_1',
        knowledgeConfirmed: true,
        status: 'paused',
      }),
    ).toBe('客服已暂停；当前草稿资料已确认');
    expect(
      assistantListStatus({
        activeReleaseId: null,
        knowledgeConfirmed: false,
        status: 'draft_only',
      }),
    ).toBe('尚未发布；当前草稿资料待确认');
  });
});
