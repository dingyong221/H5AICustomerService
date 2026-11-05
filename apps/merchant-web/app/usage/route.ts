import { collectUsageRequest } from '@h5cs/database';
import { currentMerchant } from '../account/merchant-actions';
export async function POST(request: Request) {
  try {
    const session = await currentMerchant();
    return await collectUsageRequest(
      request,
      process.env['MERCHANT_PUBLIC_ORIGIN'],
      session
        ? { role: 'merchant', id: session.merchantUserId, merchantId: session.merchantId }
        : undefined,
    );
  } catch {
    return Response.json(
      { collected: false },
      { status: 202, headers: { 'cache-control': 'no-store' } },
    );
  }
}
