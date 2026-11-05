import { cookies } from 'next/headers';
import { usageDigest } from '@h5cs/database';
import { growthEnabled, loadDatabaseConfig, MySqlGrowthUsageRepository } from '@h5cs/database';
const sources = new Map<string, { at: number; count: number }>();
export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  const origin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!origin) return new Response(null, { status: 503 });
  const response = new Response(null, {
    status: 303,
    headers: {
      location: origin + '/console/product',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
  if (!growthEnabled()) return response;
  const now = Date.now();
  for (const [key, value] of sources) if (now - value.at >= 60000) sources.delete(key);
  const key = usageDigest(_request.headers.get('x-real-ip') ?? 'unknown').toString('hex');
  const entry = sources.get(key) ?? { at: now, count: 0 };
  if (entry.count >= 60 || (!sources.has(key) && sources.size >= 5000)) return response;
  entry.count++;
  sources.set(key, entry);
  const database = loadDatabaseConfig();
  if (!database.configured) return response;
  const name = new URL(origin).protocol === 'https:' ? '__Host-h5cs_invite' : 'h5cs_invite';
  try {
    const store = await cookies(),
      { code } = await params;
    const touch = await new MySqlGrowthUsageRepository(database.config).touch(
      code,
      store.get(name)?.value,
    );
    if (touch)
      response.headers.set(
        'set-cookie',
        `${name}=${touch.token}; Path=/; Expires=${touch.expiresAt.toUTCString()}; HttpOnly; SameSite=Lax${new URL(origin).protocol === 'https:' ? '; Secure' : ''}`,
      );
  } catch {
    /* Attribution failure must not block the public product page. */
  }
  return response;
}
