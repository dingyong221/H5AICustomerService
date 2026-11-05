import { collectUsageRequest } from '@h5cs/database';
import { currentMerchant } from '../account/merchant-actions';
export async function POST(request: Request) {
  try {
    const session = await currentMerchant();
    const consumerOrigin = process.env['CONSUMER_H5_ORIGIN'];
    const expectedOrigin =
      consumerOrigin && request.headers.get('origin') === consumerOrigin
        ? consumerOrigin
        : process.env['MERCHANT_PUBLIC_ORIGIN'];
    return await collectUsageRequest(
      request,
      expectedOrigin,
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
