import type { MaterialOrganization } from '@h5cs/contracts';

export const knowledgeHeadings = [
  '商品/服务',
  '规格',
  '价格与适用条件',
  '优惠',
  '配送售后',
  '常见问答',
  '营业时间',
  '服务范围',
  '联系方式',
  '其他已提供信息',
] as const;

export type KnowledgeUnit = Readonly<{ id: string; text: string; sourceLabel: string }>;

const reviewNotice = '整理稿仅对原文分类摘录，请核对事实、适用条件、来源和完整性。';
const omissionNotice = '整理稿未涵盖全部原文，请对照材料核对遗漏及适用条件。';
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function chunks(text: string, sourceLabel: string): Omit<KnowledgeUnit, 'id'>[] {
  const result: Omit<KnowledgeUnit, 'id'>[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1200, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    const part = text.slice(start, end).trim();
    if (part) result.push({ text: part, sourceLabel });
    start = end;
  }
  return result;
}

/** Keep complete source sentences/lines, including negation and price conditions. */
export function buildKnowledgeUnits(source: string): readonly KnowledgeUnit[] {
  const normalized = source.replace(/\r\n?/gu, '\n').trim();
  const parts: Omit<KnowledgeUnit, 'id'>[] = [];
  for (const block of normalized.split(/(?=^【来源：[^\n]{1,200}】\n)/mu)) {
    const label = /^(【来源：[^\n]{1,200}】)\n/u.exec(block);
    const body = label ? block.slice(label[0].length) : block;
    for (const sentence of body.split(/(?<=[。\n])/u))
      parts.push(...chunks(sentence, label?.[1] ?? ''));
  }
  // Dense tables/very short lines cannot create an unbounded classification plan.
  const bounded = parts.length <= 80 ? parts : chunks(normalized, '');
  return bounded.map((unit, index) => ({ id: `u${index}`, ...unit }));
}

/**
 * The model selects whole unit IDs; only server-owned source text becomes facts.
 * This does not prove classification, completeness or cross-sentence semantics.
 */
export function renderKnowledgeOrganization(
  source: string,
  value: unknown,
): MaterialOrganization | null {
  const plan = object(value);
  const units = buildKnowledgeUnits(source);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const groups = plan?.['groups'];
  const reviewIds = plan?.['reviewUnitIds'] ?? [];
  const validIds = (ids: unknown): ids is string[] =>
    Array.isArray(ids) &&
    ids.length <= 80 &&
    ids.every((id) => typeof id === 'string' && byId.has(id));
  if (!Array.isArray(groups) || !groups.length || groups.length > 20 || !validIds(reviewIds))
    return null;
  const selected = new Map<string, string[]>();
  for (const raw of groups) {
    const group = object(raw);
    const topic = group?.['topic'];
    const ids = group?.['unitIds'];
    if (typeof topic !== 'string' || !topic.trim() || topic.length > 100 || !validIds(ids))
      return null;
    const heading = knowledgeHeadings.find((label) => label === topic) ?? '其他已提供信息';
    selected.set(heading, [...(selected.get(heading) ?? []), ...ids]);
  }
  const lines: string[] = [];
  const used = new Set<string>();
  outer: for (const [heading, ids] of selected) {
    let started = false;
    let previousSource = '';
    for (const id of ids) {
      if (used.has(id)) continue;
      const unit = byId.get(id)!;
      const additions = [
        ...(!started ? [`${heading}：`] : []),
        ...(unit.sourceLabel && unit.sourceLabel !== previousSource ? [unit.sourceLabel] : []),
        unit.text,
      ];
      if ([...lines, ...additions].join('\n').length > 4000) break outer;
      lines.push(...additions);
      used.add(id);
      started = true;
      previousSource = unit.sourceLabel;
    }
  }
  if (!used.size) return null;
  const warnings = [reviewNotice];
  if (used.size < units.length) warnings.push(omissionNotice);
  if (reviewIds.length) warnings.push('原文有待核对事项，请对照来源确认冲突、有效版本或适用条件。');
  for (const id of new Set(reviewIds)) {
    const quote = `需核对原文：${byId.get(id)!.text}`;
    if (quote.length <= 200 && warnings.length < 10) warnings.push(quote);
  }
  return { summary: lines.join('\n'), warnings };
}
