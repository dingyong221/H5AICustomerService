import QRCode from 'qrcode';
import { currentMerchant } from '../../../account/merchant-actions';
import { growthEnabled, loadDatabaseConfig, MySqlGrowthUsageRepository } from '@h5cs/database';
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ merchantId: string }> },
) {
  const { merchantId } = await params,
    session = await currentMerchant(merchantId),
    database = loadDatabaseConfig(),
    origin = process.env['MERCHANT_PUBLIC_ORIGIN'];
  if (!growthEnabled() || !session || !database.configured || !origin)
    return new Response(null, { status: 403 });
  try {
    const code = await new MySqlGrowthUsageRepository(database.config).invitation(
      merchantId,
      session.merchantUserId,
    );
    if (!code) return new Response(null, { status: 404 });
    const png = await QRCode.toBuffer(origin + '/console/r/' + code, { width: 640, margin: 4 });
    return new Response(new Uint8Array(png), {
      headers: {
        'content-type': 'image/png',
        'content-disposition': 'attachment; filename="kelaida-merchant-invitation.png"',
        'cache-control': 'private, no-store',
      },
    });
  } catch {
    return new Response(null, { status: 403 });
  }
}
