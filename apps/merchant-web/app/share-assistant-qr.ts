import QRCode from 'qrcode';

export function generateAssistantQrDataUrl(href: string): Promise<string> {
  return QRCode.toDataURL(href, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 224,
    color: { dark: '#173d2e', light: '#ffffffff' },
  });
}
