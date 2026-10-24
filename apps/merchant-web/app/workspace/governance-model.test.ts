import { describe, expect, it } from 'vitest';
import { governanceNextStep, type PublicationGovernance } from './governance-model';
const base = {
  draftRevision: 4,
  activeReleaseNo: 1,
  activeDraftRevision: 3,
  hasUnpublishedChanges: true,
  hasPublishedHistory: true,
  canManage: true,
  quality: { state: 'not_tested', checkId: null, question: null, answer: null, testedAt: null },
  issues: [],
  capacity: {
    effectiveCharacters: 100,
    maximumCharacters: 4000,
    uploadedMaterialCount: 2,
    sourceCoverage: 'not_tracked',
  },
  withdrawal: { withdrawnThroughReleaseNo: 0, withdrawnAt: null, reason: null },
} satisfies PublicationGovernance;
describe('merchant next actionable step', () => {
  it('fails closed when unavailable and keeps viewers read-only', () => {
    expect(governanceNextStep(null).label).toContain('刷新');
    expect(governanceNextStep({ ...base, canManage: false }).section).toBe('publish');
  });
  it('prioritizes blocking facts ahead of quality/publish', () => {
    const next = governanceNextStep({
      ...base,
      issues: [
        {
          code: 'FAQ_CONFLICT',
          field: 'materialsSummary',
          detail: '同题不同答',
          severity: 'blocking',
        },
      ],
    });
    expect(next.section).toBe('drafts');
  });
  it('asks for a same-revision test and a human judgment, rather than claiming successful publication', () => {
    expect(governanceNextStep(base).section).toBe('preview');
    expect(
      governanceNextStep({ ...base, quality: { ...base.quality, state: 'needs_review' } }).label,
    ).toContain('判定');
    expect(
      governanceNextStep({ ...base, quality: { ...base.quality, state: 'failed' } }).label,
    ).toContain('修正');
  });
  it('only suggests publishing after pass, otherwise shares the retained active link', () => {
    const passed = { ...base, quality: { ...base.quality, state: 'passed' as const } };
    expect(governanceNextStep(passed).label).toContain('发布本修订');
    expect(governanceNextStep({ ...passed, hasUnpublishedChanges: false }).label).toContain(
      '客户链接',
    );
  });
  it('does not present an unchanged legacy published assistant as unavailable merely because it has no new preview record', () => {
    const next = governanceNextStep({ ...base, hasUnpublishedChanges: false });
    expect(next.label).toContain('客户链接');
    expect(next.detail).toContain('再次发布');
  });
});
