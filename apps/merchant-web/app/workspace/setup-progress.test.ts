import { describe, expect, it } from 'vitest';
import type { AssistantManagementSnapshot } from '@h5cs/domain';
import type { PublicationGovernance } from './governance-model';
import { setupProgress } from './setup-progress';
import { retailReviewFixture } from './draft-readiness.fixtures';
import { retailDefaultDraft } from './retail-preset';

const assistant = {
  assistantId: 'aa'.repeat(16),
  merchantId: 'bb'.repeat(16),
  displayName: '测试客服',
  publicSlug: 'a-test',
  status: 'draft_only',
  draftRevision: 4,
  draft: retailReviewFixture,
  knowledgeConfirmed: false,
  activeReleaseId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as AssistantManagementSnapshot;
const governance = {
  draftRevision: 4,
  activeReleaseNo: null,
  activeDraftRevision: null,
  hasUnpublishedChanges: true,
  hasPublishedHistory: false,
  canManage: true,
  quality: { state: 'not_tested', checkId: null, question: null, answer: null, testedAt: null },
  issues: [],
  capacity: {
    effectiveCharacters: 100,
    maximumCharacters: 4000,
    uploadedMaterialCount: 0,
    sourceCoverage: 'not_tracked',
  },
  withdrawal: { withdrawnThroughReleaseNo: 0, withdrawnAt: null, reason: null },
} satisfies PublicationGovernance;
describe('merchant setup progress from saved business state', () => {
  it('starts empty merchants at basic information without a fake completion count', () => {
    const progress = setupProgress(null, null);
    expect(progress.next.section).toBe('drafts');
    expect(progress.steps.every((step) => !step.status.includes('已'))).toBe(true);
  });
  it('routes template-only businesses to knowledge preparation, not straight to publish', () => {
    expect(
      setupProgress({ ...assistant, draft: retailDefaultDraft }, governance).next.section,
    ).toBe('knowledge');
  });
  it('never treats uploaded attachments as knowledge completion', () => {
    const uploaded = {
      ...governance,
      capacity: { ...governance.capacity, uploadedMaterialCount: 8 },
    };
    expect(
      setupProgress({ ...assistant, draft: retailDefaultDraft }, uploaded).steps[1]?.status,
    ).toBe('建议补充');
    expect(setupProgress(assistant, governance).steps[1]?.status).toContain('待人工核对');
  });
  it('prioritizes blocking facts and read-only access over missing-material suggestions', () => {
    const draft = { ...assistant, draft: retailDefaultDraft };
    expect(setupProgress(draft, { ...governance, canManage: false }).next.section).toBe('publish');
    expect(
      setupProgress(draft, {
        ...governance,
        issues: [
          {
            code: 'FAQ_CONFLICT',
            field: 'materialsSummary',
            severity: 'blocking',
            detail: '资料冲突',
          },
        ],
      }).next.section,
    ).toBe('drafts');
  });
  it('fails closed on missing or stale governance, even when an earlier test passed', () => {
    for (const state of [
      null,
      {
        ...governance,
        draftRevision: 3,
        quality: { ...governance.quality, state: 'passed' as const },
      },
    ]) {
      const progress = setupProgress(assistant, state);
      expect(progress.next.label).toContain('刷新');
      expect(progress.steps[2]?.status).toBe('待核对');
      expect(progress.notice).not.toContain('没有待发布');
    }
  });
  it('distinguishes testing, human judgment, failure and ready-to-publish states', () => {
    expect(setupProgress(assistant, governance).next.section).toBe('preview');
    expect(
      setupProgress(assistant, {
        ...governance,
        quality: { ...governance.quality, state: 'needs_review' },
      }).next.label,
    ).toContain('判定');
    expect(
      setupProgress(assistant, {
        ...governance,
        quality: { ...governance.quality, state: 'failed' },
      }).next.label,
    ).toContain('修正');
    expect(
      setupProgress(assistant, {
        ...governance,
        quality: { ...governance.quality, state: 'passed' },
      }).next.label,
    ).toContain('发布');
  });
  it('keeps a published legacy assistant shareable without requiring a new preview', () => {
    const live = {
      ...assistant,
      status: 'active' as const,
      activeReleaseId: 'cc'.repeat(16) as NonNullable<
        AssistantManagementSnapshot['activeReleaseId']
      >,
      draft: retailDefaultDraft,
    };
    const state = { ...governance, activeReleaseNo: 1, hasUnpublishedChanges: false };
    expect(setupProgress(live, state).next.label).toContain('客户链接');
    expect(setupProgress(live, state).steps[2]?.status).toBe('重新发布需试聊');
    expect(setupProgress(live, { ...state, hasUnpublishedChanges: true }).notice).toContain(
      '客户仍使用已发布版本',
    );
  });
  it('prioritizes pause/withdrawal status rather than showing a published service as available', () => {
    const progress = setupProgress({ ...assistant, status: 'paused' }, governance);
    expect(progress.live).toBe(false);
    expect(progress.next.label).toContain('暂停');
    expect(progress.steps[3]?.status).toBe('已暂停');
  });
});
