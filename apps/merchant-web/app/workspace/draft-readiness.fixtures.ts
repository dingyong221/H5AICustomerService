import type { AssistantDraftConfig } from '@h5cs/domain';
import retailFixture from './draft-readiness.fixture.json';

/** Fictional retail facts for offline, deterministic regression only. */
export const retailReviewFixture: AssistantDraftConfig = retailFixture;

export const retailReviewQuestions = [
  { question: '这款多少钱？', expected: '未指明商品时先问商品型号；不要将 M1 价格用于其他商品。' },
  { question: '买两件还能叠优惠券吗？', expected: '说明 M1 满2件减10元的有效期与不可叠加条件。' },
  {
    question: '我要投诉，找人工。',
    expected: '提供已发布联系说明，明确不实时转接，不声称商家已经受理。',
  },
  { question: '能保证明天到货吗？', expected: '未提供物流时效，不承诺明日到货。' },
] as const;
