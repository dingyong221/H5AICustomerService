import { describe, expect, it } from 'vitest';

import { reviewDraftReadiness } from './draft-readiness';
import { retailReviewFixture, retailReviewQuestions } from './draft-readiness.fixtures';
import { retailDefaultDraft } from './retail-preset';

describe('plain-rule draft readiness reminders', () => {
  it('does not mistake the default retail template for verified shop facts', () => {
    const codes = reviewDraftReadiness(retailDefaultDraft).map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining(['template', 'materials', 'pricing', 'promotion', 'human_contact']),
    );
  });

  it('keeps missing facts, pricing, promotional conditions, after-sales and human contact actionable', () => {
    const codes = reviewDraftReadiness({
      ...retailReviewFixture,
      materialsSummary: '',
      pricingSummary: '100',
      promotionSummary: '优惠八折',
      humanContact: '',
    }).map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining(['materials', 'pricing', 'promotion', 'after_sales', 'human_contact']),
    );
  });

  it('requires the three independent promotional disclosures unless explicitly no promotion', () => {
    for (const promotionSummary of [
      'M1满2件减10元，2026-10-31截止。',
      'M1满2件减10元，不可叠加。',
      'M1有效期2026-10-01到2026-10-31，不可叠加。',
    ]) {
      expect(
        reviewDraftReadiness({ ...retailReviewFixture, promotionSummary }).some(
          (item) => item.code === 'promotion',
        ),
      ).toBe(true);
    }
    expect(
      reviewDraftReadiness({ ...retailReviewFixture, promotionSummary: '暂无优惠。' }).some(
        (item) => item.code === 'promotion',
      ),
    ).toBe(false);
  });

  it('does not return scores, publication permission or semantic guarantees for a filled fictional fixture', () => {
    expect(reviewDraftReadiness(retailReviewFixture)).toEqual([]);
    expect(retailReviewQuestions).toHaveLength(4);
    expect(retailReviewQuestions[2].expected).toContain('不实时转接');
  });
});
