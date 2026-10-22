import type { AssistantDraftConfig } from '@h5cs/domain';
export type PreviewEvidence = readonly Readonly<{ label: string; text: string }>[];
/** Actual input facts, not model-generated citations or inferred retrieval hits. */
export function previewEvidence(draft: AssistantDraftConfig): PreviewEvidence {
  return [
    { label: '细分行业', text: draft.industry },
    { label: '业务范围', text: draft.businessScope },
    { label: '商品与服务资料（含已保存的来源标记）', text: draft.materialsSummary },
    { label: '价格与适用条件', text: draft.pricingSummary },
    { label: '优惠与售卖策略', text: draft.promotionSummary },
    { label: '人工联系说明', text: draft.humanContact ?? '' },
  ].filter((item) => item.text.trim());
}
