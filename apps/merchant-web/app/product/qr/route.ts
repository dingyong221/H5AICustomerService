import QRCode from 'qrcode';
import { selfServicePolicy } from '@h5cs/database';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const offer = selfServicePolicy(process.env);
  if (!offer) return new Response('商家自助开通暂未开放', { status: 404 });
  const png = await QRCode.toBuffer(offer.origin + '/console/product', {
    type: 'png',
    width: 640,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(new URL(request.url).searchParams.get('download') === '1'
        ? { 'Content-Disposition': 'attachment; filename="h5ai-merchant-activation.png"' }
        : {}),
    },
  });
}
