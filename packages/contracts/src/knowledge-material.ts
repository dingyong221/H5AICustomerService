export type MaterialOrganization = Readonly<{ summary: string; warnings: readonly string[] }>;
export type MaterialOrganizationInput = Readonly<{ text: string }>;
export function parseMaterialOrganization(value: unknown): MaterialOrganization | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { summary, warnings } = value as Record<string, unknown>;
  const valid = (text: unknown, max: number): text is string =>
    typeof text === 'string' &&
    !!text.trim() &&
    text.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
  if (
    !valid(summary, 4000) ||
    !Array.isArray(warnings) ||
    warnings.length > 10 ||
    !warnings.every((text) => valid(text, 200))
  )
    return null;
  return { summary: summary.trim(), warnings: warnings as string[] };
}
