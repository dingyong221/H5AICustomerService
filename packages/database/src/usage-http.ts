import { randomBytes } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import {
  growthEnabled,
  MySqlGrowthUsageRepository,
  usageBatchSchema,
  usageDigest,
  type UsageIdentity,
} from './growth-usage.js';
import { loadDatabaseConfig } from './config.js';
const sources = new Map<string, { at: number; count: number }>();
export async function collectUsageRequest(
  request: Request,
  origin: string | undefined,
  principal?: { role: 'merchant' | 'operator'; id: string; merchantId?: string },
) {
  const response = (status: number, data: unknown) =>
    Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
  if (!origin || request.headers.get('origin') !== origin)
    return response(403, { collected: false });
  if (request.headers.get('x-usage-optout') === '1') {
    const r = new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }),
      secure = new URL(origin).protocol === 'https:';
    r.headers.set(
      'set-cookie',
      `${secure ? '__Host-h5cs_usage' : 'h5cs_usage'}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
    return r;
  }
  if (!growthEnabled()) return response(202, { collected: false, reason: 'disabled' });
  if (request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1')
    return response(202, { collected: false, reason: 'privacy' });
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return response(415, { collected: false });
  const key = usageDigest(request.headers.get('x-real-ip') ?? 'unknown').toString('hex'),
    now = Date.now();
  for (const [k, v] of sources) if (now - v.at >= 60000) sources.delete(k);
  const entry = sources.get(key) ?? { at: now, count: 0 };
  if (entry.count >= 600 || (!sources.has(key) && sources.size >= 5000))
    return response(429, { collected: false });
  entry.count++;
  sources.set(key, entry);
  const reader = request.body?.getReader();
  if (!reader) return response(400, { collected: false });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 32768) {
        await reader.cancel();
        return response(413, { collected: false });
      }
      parts.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    return response(400, { collected: false });
  }
  const parsed = usageBatchSchema.safeParse(raw);
  if (!parsed.success) return response(400, { collected: false });
  const database = loadDatabaseConfig();
  if (!database.configured) return response(202, { collected: false, reason: 'unavailable' });
  const secure = new URL(origin).protocol === 'https:',
    cookieName = secure ? '__Host-h5cs_usage' : 'h5cs_usage';
  const old = request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
  const token =
    old && /^[A-Za-z0-9_-]{43}$/u.test(old) ? old : randomBytes(32).toString('base64url');
  let identity: UsageIdentity = principal
    ? {
        role: principal.role,
        actor: principal.id,
        ...(principal.merchantId ? { merchantId: principal.merchantId } : {}),
      }
    : { role: 'anonymous', actor: token };
  if (parsed.data.publicRef) {
    const c = await database.config.openConnection();
    try {
      const [rows] = await c.execute<RowDataPacket[]>(
        `SELECT LOWER(HEX(merchant_id)) merchant_id FROM assistant WHERE public_slug=? AND status='active' AND active_release_id IS NOT NULL LIMIT 1`,
        [parsed.data.publicRef],
      );
      if (rows.length)
        identity = { role: 'consumer', actor: token, merchantId: String(rows[0]!['merchant_id']) };
    } finally {
      await c.end();
    }
  }
  try {
    const accepted = await new MySqlGrowthUsageRepository(database.config).collect(
      identity,
      parsed.data.events,
    );
    const result = response(202, { collected: accepted > 0, accepted });
    result.headers.set(
      'set-cookie',
      `${cookieName}=${token}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`,
    );
    return result;
  } catch {
    return response(202, { collected: false, reason: 'unavailable' });
  }
}
