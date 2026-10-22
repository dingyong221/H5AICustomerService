import type { MaterialOrganization } from '@h5cs/contracts';

export const knowledgeHeadings = [
  '商品/服务',
  '规格',
  '价格与适用条件',
  '优惠',
  '配送售后',
  '常见问答',
  '其他已提供信息',
] as const;

export const knowledgeReviewNotices = [
  '需商家补充或确认。',
  '请对照原文核对适用条件与遗漏。',
  '请核对原文中的潜在冲突，不要直接作为已确认事实。',
] as const;

/**
 * Only group source excerpts; do not trust newly generated business assertions.
 * This proves literal support, not completeness, context or semantic correctness.
 */
export function isSourceGroundedOrganization(
  source: string,
  result: MaterialOrganization,
): boolean {
  const normalizedSource = source.replace(/\r\n?/gu, '\n');
  const notices = new Set<string>(knowledgeReviewNotices);
  let hasSourceExcerpt = false;
  for (const rawLine of result.summary.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (normalizedSource.includes(line)) {
      if (!/^【来源：[^\n]+】$/u.test(line)) hasSourceExcerpt = true;
      continue;
    }
    const heading = knowledgeHeadings.find(
      (value) => line.startsWith(`${value}：`) || line.startsWith(`${value}:`),
    );
    const excerpt = heading ? line.slice(heading.length + 1).trim() : line;
    if (!excerpt && heading) continue;
    if (notices.has(excerpt)) continue;
    if (!excerpt || !normalizedSource.includes(excerpt)) return false;
    hasSourceExcerpt = true;
  }
  return (
    hasSourceExcerpt &&
    result.warnings.every((warning) => {
      if (notices.has(warning)) return true;
      const excerpt = warning.startsWith('需核对原文：')
        ? warning.slice('需核对原文：'.length).trim()
        : warning;
      return !!excerpt && normalizedSource.includes(excerpt);
    })
  );
}
