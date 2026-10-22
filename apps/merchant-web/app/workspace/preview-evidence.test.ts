import { describe, expect, it } from 'vitest';
import { retailDefaultDraft } from './retail-preset';
import { previewEvidence } from './preview-evidence';
describe('preview evidence is the sent draft rather than hallucinated citations', () => {
  it('retains source labels, original prices, conditions and unknowns without exposing empty contact', () => {
    const draft = {
      ...retailDefaultDraft,
      materialsSummary: '【来源：商品表.csv】\n保温杯39元/件；新疆单件运费15元。',
      humanContact: '',
    };
    const evidence = previewEvidence(draft);
    expect(evidence).toContainEqual({
      label: '商品与服务资料（含已保存的来源标记）',
      text: draft.materialsSummary,
    });
    expect(evidence.some((x) => x.label === '人工联系说明')).toBe(false);
    expect(evidence).toContainEqual({ label: '价格与适用条件', text: draft.pricingSummary });
    expect(evidence.every((x) => typeof x.text === 'string')).toBe(true);
  });
});
