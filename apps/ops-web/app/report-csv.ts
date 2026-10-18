export class ReportExportTooLargeError extends Error {}

// Quoting alone does not prevent spreadsheet formula execution. Prefix unsafe
// text, including whitespace-prefixed formulae; preserve long numeric IDs as text.
export function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  if (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) || /^\d{16,}$/u.test(text))
    text = `'${text}`;
  return `"${text.replace(/"/gu, '""')}"`;
}

export function reportCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  if (rows.some((row) => row.length !== headers.length))
    throw new Error('CSV column count mismatch');
  return (
    '\ufeff' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}
