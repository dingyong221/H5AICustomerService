export function retentionValue(
  cohort: string,
  size: number,
  returned: number,
  offset: 1 | 7 | 30,
  now = new Date(),
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(cohort) || !Number.isFinite(size) || size < 1) return '无样本';
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const observedDays =
    (Date.parse(today + 'T00:00:00Z') - Date.parse(cohort + 'T00:00:00Z')) / 86400000;
  // Count only fully completed target days: today's partial cohort is not mature.
  if (observedDays <= offset) return '未成熟';
  return `${((100 * Math.min(Math.max(returned, 0), size)) / size).toFixed(1)}%`;
}
