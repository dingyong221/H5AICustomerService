import {
  parseNative,
  parseIsolated,
  ParserFailure,
} from '../../scripts/material-parser-runtime.mjs';
export const materialTypes = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
} as const;
export class MaterialParseError extends Error {}
export function materialMime(name: string, bytes: Buffer): string {
  const extension = name.toLowerCase().split('.').at(-1) as keyof typeof materialTypes;
  if (
    !Object.hasOwn(materialTypes, extension) ||
    name.length > 200 ||
    /[\u0000-\u001f\u007f/\\]/u.test(name)
  )
    throw new MaterialParseError('文件名或格式不支持。');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new MaterialParseError('单个文件必须在 10 MB 以内，且不能为空。');
  if (extension === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new MaterialParseError('PDF 文件内容与扩展名不符。');
  if (
    ['doc', 'ppt', 'xls'].includes(extension) &&
    !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
  )
    throw new MaterialParseError('旧版 Office 文件内容与扩展名不符。');
  if (
    ['docx', 'pptx', 'xlsx'].includes(extension) &&
    !bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))
  )
    throw new MaterialParseError('Office 文件内容与扩展名不符。');
  if (['txt', 'csv', 'md'].includes(extension)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\0')) throw new Error();
    } catch {
      throw new MaterialParseError('文本文件请使用 UTF-8 编码。');
    }
  }
  return materialTypes[extension];
}
export async function parseMaterial(
  name: string,
  bytes: Buffer,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const mime = materialMime(name, bytes);
  const mode = process.env['H5CS_MATERIAL_PARSER_MODE'] ?? 'local';
  try {
    if (mode === 'isolated') return await parseIsolated(bytes, mime, options);
    if (mode === 'local') return await parseNative(bytes, mime, options);
    throw new ParserFailure('unavailable');
  } catch (error) {
    throw new MaterialParseError(
      error instanceof ParserFailure ? error.message : '文件解析服务暂不可用。',
    );
  }
}
