import {
  KnowledgeMaterialAccessError,
  loadDatabaseConfig,
  MySqlKnowledgeMaterialRepository,
} from '@h5cs/database';
import { currentMerchantForWrite } from '../account/merchant-actions';
export const materialResponse = (status: number, data: unknown) =>
  Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
export async function materialAccess(
  request: Request,
  scope: { merchantId: string; assistantId: string },
) {
  if (
    !process.env['MERCHANT_PUBLIC_ORIGIN'] ||
    request.headers.get('origin') !== process.env['MERCHANT_PUBLIC_ORIGIN'] ||
    !/^[0-9a-f]{32}$/u.test(scope.merchantId) ||
    !/^[0-9a-f]{32}$/u.test(scope.assistantId)
  )
    return null;
  const session = await currentMerchantForWrite(
    scope.merchantId,
    request.headers.get('x-h5cs-csrf') ?? '',
  );
  if (!session) return null;
  const database = loadDatabaseConfig();
  if (!database.configured) return null;
  const repository = new MySqlKnowledgeMaterialRepository(database.config);
  // Authorize the assistant before parsing files or invoking external models.
  try {
    await repository.list(scope.merchantId, scope.assistantId, session.merchantUserId);
  } catch (error) {
    if (error instanceof KnowledgeMaterialAccessError) return null;
    throw error;
  }
  return { session, database: database.config, repository };
}
export class MaterialUploadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const MATERIAL_BATCH_MS = 30000;
// Process-wide across Next route bundles. No retained waiting uploads.
const uploadGlobal = globalThis as typeof globalThis & { __h5csMaterialUploads?: number };
export function admitMaterialUpload(request: Request) {
  if ((uploadGlobal.__h5csMaterialUploads ?? 0) >= 2)
    throw new MaterialUploadError(503, '材料上传繁忙，请稍后重试。');
  uploadGlobal.__h5csMaterialUploads = (uploadGlobal.__h5csMaterialUploads ?? 0) + 1;
  const deadline = Date.now() + MATERIAL_BATCH_MS;
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, MATERIAL_BATCH_MS);
  if (request.signal.aborted) abort();
  let released = false;
  return {
    signal: controller.signal,
    remaining: () => Math.max(0, deadline - Date.now()),
    assertActive() {
      if (controller.signal.aborted || Date.now() >= deadline)
        throw new MaterialUploadError(408, '上传已中断或超时，请刷新核对已保存材料。');
    },
    release() {
      if (released) return;
      released = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      uploadGlobal.__h5csMaterialUploads! -= 1;
    },
  };
}
export async function readMaterialBody(request: Request, max: number, signal = request.signal) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^(0|[1-9][0-9]*)$/u.test(length) || Number(length) > max))
    throw new MaterialUploadError(413, '请求过大，请减少文件数量或拆分材料。');
  if (signal.aborted) throw new MaterialUploadError(408, '上传已中断或超时。');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('请求不能为空。');
  // One bounded backing allocation: millions of tiny chunks must not build a
  // byte-bounded but object-unbounded array while receiving multipart data.
  const bytes = Buffer.allocUnsafeSlow(length === null ? max : Number(length));
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new MaterialUploadError(408, '上传已中断或超时。');
      const item = await reader.read();
      if (signal.aborted) throw new MaterialUploadError(408, '上传已中断或超时。');
      if (item.done) break;
      size += item.value.byteLength;
      if (size > max || size > bytes.length) {
        await reader.cancel();
        throw new MaterialUploadError(413, '请求过大，请减少文件数量或拆分材料。');
      }
      bytes.set(item.value, size - item.value.byteLength);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  return bytes.subarray(0, size);
}
export function materialFormData(
  bytes: Buffer<ArrayBuffer>,
  contentType: string,
): Promise<FormData> {
  // Bound FormData's object count before asking the framework to construct it.
  // A byte cap alone would still permit hundreds of thousands of tiny fields.
  const match =
    /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))\s*$/u.exec(
      contentType,
    );
  const invalid = () => {
    throw new MaterialUploadError(400, '每次请选择 1–5 个文件。');
  };
  if (!match) return invalid();
  const delimiter = Buffer.from(`--${match[1] ?? match[2]}`);
  const separator = Buffer.concat([Buffer.from('\r\n'), delimiter]);
  if (
    !bytes.subarray(0, delimiter.length).equals(delimiter) ||
    bytes.toString('latin1', delimiter.length, delimiter.length + 2) !== '\r\n'
  )
    return invalid();
  let cursor = delimiter.length + 2;
  for (let count = 1; count <= 5; count++) {
    const end = bytes.indexOf('\r\n\r\n', cursor);
    if (end < cursor || end - cursor > 8192) return invalid();
    const headers = bytes.toString('latin1', cursor, end).split('\r\n');
    if (
      headers.length > 2 ||
      headers.filter((h) =>
        /^content-disposition: form-data; name="files"; filename="[^"\r\n]*"$/iu.test(h),
      ).length !== 1 ||
      headers.some(
        (h) => !/^content-disposition: /iu.test(h) && !/^content-type: [^\r\n]+$/iu.test(h),
      )
    )
      return invalid();
    const next = bytes.indexOf(separator, end + 4);
    if (next < 0) return invalid();
    cursor = next + separator.length;
    const suffix = bytes.toString('latin1', cursor, cursor + 2);
    if (suffix === '--') {
      const trailing = bytes.subarray(cursor + 2);
      if (trailing.length && !trailing.equals(Buffer.from('\r\n'))) return invalid();
      return new Response(bytes, { headers: { 'content-type': contentType } }).formData();
    }
    if (suffix !== '\r\n') return invalid();
    cursor += 2;
  }
  return invalid();
}
const requests = new Map<string, number[]>();
export function materialRateLimit(merchant: string) {
  const now = Date.now();
  for (const [key, times] of requests)
    if (times.every((time) => time < now - 60000)) requests.delete(key);
  const recent = (requests.get(merchant) ?? []).filter((time) => time >= now - 60000);
  if (recent.length >= 5 || requests.size >= 1000)
    throw new Error('材料操作繁忙，请一分钟后再试。');
  recent.push(now);
  requests.set(merchant, recent);
}
