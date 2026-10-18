// Safe in both client navigation and server download URLs; no database imports.
export const opsHref = (path: string): string =>
  `${process.env['NEXT_PUBLIC_OPS_BASE_PATH'] ?? ''}${path}`;
