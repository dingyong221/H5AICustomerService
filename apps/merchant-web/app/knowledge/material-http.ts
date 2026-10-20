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
export async function readMaterialBody(request: Request, max: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('请求不能为空。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Error('请求过大，请减少文件数量或拆分材料。');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
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
