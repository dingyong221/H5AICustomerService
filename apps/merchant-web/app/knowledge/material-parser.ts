import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
// Shared across requests in this server worker. Reject rather than retain
// unbounded queues of 10 MB uploads while native extraction is occupied.
let activeParsers = 0;
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
export async function parseMaterial(name: string, bytes: Buffer): Promise<string> {
  const mime = materialMime(name, bytes);
  if (activeParsers >= 2) throw new MaterialParseError('材料解析繁忙，请稍后重试。');
  activeParsers += 1;
  return new Promise((resolve, reject) => {
    // No shell, filenames or secrets are passed to the parser. Only bytes and
    // an allowlisted MIME. Kill the entire owned child on timeout or overflow.
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=256', join(process.cwd(), 'scripts/extract-material.mjs'), mime],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          NODE_ENV: 'production',
          // Production pre-extracts the version-pinned bundled PDFium library
          // into a root-owned read-only image directory. Reuse it there without
          // making the normal /tmp mount executable. Local/CI has no such path.
          ...(process.platform === 'linux' &&
          existsSync('/app/parser-runtime/kreuzberg-pdfium/libpdfium.so')
            ? { TMPDIR: '/app/parser-runtime' }
            : {}),
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
        },
      },
    );
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const finish = (error?: string, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(new MaterialParseError(error));
      } else resolve(text!);
    };
    const timer = setTimeout(() => finish('解析超时，请拆分文件后重试。'), 20000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 150000) finish('文件文字过多，请拆分材料。');
      else chunks.push(chunk);
    });
    child.on('error', () => finish('文件解析服务暂不可用。'));
    child.stdin.on('error', () => {
      /* Exit is handled below; never print supplied data. */
    });
    child.on('close', (code) => {
      activeParsers -= 1;
      if (code !== 0) {
        finish(
          code === 3
            ? '文件无可提取文字，或文字超过 24000 字；请使用含文字的文件或拆分材料。'
            : '文件无法解析，可能已损坏、加密或格式不兼容。',
        );
        return;
      }
      try {
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const text = (payload as { text?: unknown })?.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 24000) throw new Error();
        finish(undefined, text);
      } catch {
        finish('文件解析结果无效。');
      }
    });
    child.stdin.end(bytes);
  });
}
