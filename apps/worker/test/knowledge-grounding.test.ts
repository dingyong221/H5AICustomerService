import { describe, expect, it } from 'vitest';

import {
  isSourceGroundedOrganization,
  knowledgeReviewNotices,
} from '../src/knowledge-grounding.js';

const source =
  '【来源：商品表.xlsx】\r\n毛巾29元/条；新疆单件运费15元。\r\n多件运费与包邮资格待确认。';

describe('source-grounded material organization', () => {
  it('allows themed verbatim excerpts, source labels and a fixed non-factual review notice', () => {
    expect(
      isSourceGroundedOrganization(source, {
        summary:
          '【来源：商品表.xlsx】\n商品/服务：\n毛巾29元/条；新疆单件运费15元。\n配送售后: 多件运费与包邮资格待确认。\n优惠：需商家补充或确认。',
        warnings: [knowledgeReviewNotices[1], '需核对原文：多件运费与包邮资格待确认。'],
      }),
    ).toBe(true);
  });
  it.each([
    '毛巾29元/条；新疆单件运费15元。\n不提供送货服务。',
    '商品/服务：毛巾29元/条；新疆单件运费15元。以商家系统为准。',
    '商品/服务：\n需商家补充或确认。',
    '未提供配送政策，因此不配送。',
    '多件运费与包邮资格不符合。',
    '商品.xlsx：毛巾29元/条。',
    '【来源：商品表.xlsx】\n商品/服务：需商家补充或确认。',
  ])('rejects generated assertions or notice-only output: %s', (summary) => {
    expect(isSourceGroundedOrganization(source, { summary, warnings: [] })).toBe(false);
  });
  it('retains an explicitly supplied negative policy instead of converting unknown into negative', () => {
    expect(
      isSourceGroundedOrganization('不配送。仅提供咨询服务，不执行清洗。', {
        summary: '配送售后：不配送。\n商品/服务：仅提供咨询服务，不执行清洗。',
        warnings: [],
      }),
    ).toBe(true);
  });
  it('does not silently normalize or paraphrase price conditions or source names', () => {
    expect(
      isSourceGroundedOrganization(source, {
        summary: '毛巾29元/条；新疆单件运费15元。',
        warnings: ['需核对原文：多件运费、包邮资格待确认。'],
      }),
    ).toBe(false);
  });
});
