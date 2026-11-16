import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

export const SOCKET_PATH = '/run/h5cs-material-parser/parser.sock';
export const MAX_INPUT = 10 * 1024 * 1024;
export const MAX_OUTPUT = 150000;
export const MAX_TIME = 20000;
export const MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
  'text/markdown',
];
const messages = {
  busy: '材料解析繁忙，请稍后重试。',
  unavailable: '文件解析服务暂不可用。',
  timeout: '解析超时，请拆分文件后重试。',
  cancelled: '上传已中断，请刷新核对已保存材料。',
  overflow: '文件文字过多，请拆分材料。',
  empty: '文件无可提取文字，或文字超过 24000 字；请使用含文字的文件或拆分材料。',
  invalid: '文件无法解析，可能已损坏、加密或格式不兼容。',
  result: '文件解析结果无效。',
};
export class ParserFailure extends Error {
  constructor(code) {
    super(messages[code] ?? messages.unavailable);
    this.code = Object.hasOwn(messages, code) ? code : 'unavailable';
  }
}
export function validateBytes(bytes, mime) {
  if (!MIME_TYPES.includes(mime) || !bytes.length || bytes.length > MAX_INPUT)
    throw new ParserFailure('invalid');
  if (mime === MIME_TYPES[0] && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new ParserFailure('invalid');
  if (
    [MIME_TYPES[1], MIME_TYPES[3], MIME_TYPES[5]].includes(mime) &&
    !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
  )
    throw new ParserFailure('invalid');
  if (
    [MIME_TYPES[2], MIME_TYPES[4], MIME_TYPES[6]].includes(mime) &&
    !bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex'))
  )
    throw new ParserFailure('invalid');
  if (mime.startsWith('text/')) {
    try {
      if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) throw new Error();
    } catch {
      throw new ParserFailure('invalid');
    }
  }
}
function textResult(bytes) {
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !payload ||
      Object.keys(payload).length !== 1 ||
      typeof payload.text !== 'string' ||
      !payload.text.trim() ||
      payload.text.length > 24000
    )
      throw new Error();
    return payload.text;
  } catch {
    throw new ParserFailure('result');
  }
}

let active = 0;
// No queue. Linux children have their own process group; never signal the Web's group.
export function parseNative(bytes, mime, { signal, timeoutMs = MAX_TIME, concurrency = 2 } = {}) {
  validateBytes(bytes, mime);
  if (signal?.aborted) return Promise.reject(new ParserFailure('cancelled'));
  if (timeoutMs <= 0) return Promise.reject(new ParserFailure('timeout'));
  if (active >= concurrency) return Promise.reject(new ParserFailure('busy'));
  active += 1;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        process.execPath,
        ['--max-old-space-size=256', join(process.cwd(), 'scripts/extract-material.mjs'), mime],
        {
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            NODE_ENV: 'production',
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
    } catch {
      active -= 1;
      reject(new ParserFailure('unavailable'));
      return;
    }
    const chunks = [];
    let size = 0,
      settled = false,
      closed = false;
    const kill = () => {
      if (closed) return;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          /* own group exited */
        }
      }
      child.kill('SIGKILL');
    };
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) {
        kill();
        reject(new ParserFailure(error));
      } else resolve(text);
    };
    const cancel = () => finish('cancelled');
    const timer = setTimeout(() => finish('timeout'), Math.min(MAX_TIME, timeoutMs));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_OUTPUT) finish('overflow');
      else chunks.push(chunk);
    });
    child.on('error', () => finish('unavailable'));
    child.stdin.on('error', () => {
      /* no supplied content or native stderr in logs */
    });
    child.on('close', (code) => {
      closed = true;
      active -= 1; // Keep the slot through SIGKILL until actual process closure.
      if (settled) return;
      if (code !== 0) {
        finish(code === 3 ? 'empty' : 'invalid');
        return;
      }
      try {
        finish(undefined, textResult(Buffer.concat(chunks)));
      } catch {
        finish('result');
      }
    });
    if (!settled) child.stdin.end(bytes);
  });
}

// Only this constant socket is accepted; no host, URL, filename or arbitrary path.
export function parseIsolated(bytes, mime, { signal, timeoutMs = MAX_TIME } = {}) {
  validateBytes(bytes, mime);
  if (signal?.aborted) return Promise.reject(new ParserFailure('cancelled'));
  if (timeoutMs <= 0) return Promise.reject(new ParserFailure('timeout'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) {
        req.destroy();
        reject(new ParserFailure(error));
      } else resolve(text);
    };
    const req = request({
      socketPath: SOCKET_PATH,
      path: '/v1/extract',
      method: 'POST',
      agent: false,
      headers: { 'content-type': mime, 'content-length': bytes.length, connection: 'close' },
    });
    const cancel = () => finish('cancelled');
    const timer = setTimeout(() => finish('timeout'), Math.min(MAX_TIME, timeoutMs));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    req.on('error', () => finish('unavailable'));
    req.on('response', (res) => {
      const length = res.headers['content-length'];
      if (
        res.headers['content-type'] !== 'application/json' ||
        res.headers['transfer-encoding'] ||
        !/^[1-9][0-9]{0,5}$/u.test(length ?? '') ||
        Number(length) > MAX_OUTPUT ||
        res.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'content-length')
          .length !== 1
      ) {
        res.destroy();
        finish('result');
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) {
          res.destroy();
          finish('overflow');
        } else if (!settled) chunks.push(chunk);
      });
      res.on('error', () => finish('unavailable'));
      res.on('end', () => {
        if (settled) return;
        if (!res.complete || size !== Number(length)) {
          finish('result');
          return;
        }
        const result = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          try {
            const payload = JSON.parse(result.toString('utf8'));
            if (Object.keys(payload).length !== 1 || !Object.hasOwn(messages, payload.error))
              throw new Error();
            finish(payload.error);
          } catch {
            finish('result');
          }
          return;
        }
        try {
          finish(undefined, textResult(result));
        } catch {
          finish('result');
        }
      });
    });
    if (!settled) req.end(bytes);
  });
}
