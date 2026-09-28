import { describe, expect, it } from 'vitest';

import { generateAssistantQrDataUrl } from './share-assistant-qr';
import { safeShareAssistantUrl } from './share-assistant-url';

describe('published assistant sharing', () => {
  const origin = 'https://h5cs.1rying.com';

  it('only shares a fixed public assistant path on the configured origin', () => {
    expect(safeShareAssistantUrl(`${origin}/a/demo-shop`, origin)).toBe(`${origin}/a/demo-shop`);
    for (const unsafe of [
      'https://other.example/a/demo-shop',
      'http://h5cs.1rying.com/a/demo-shop',
      `${origin}/workspace/private`,
      `${origin}/a/demo-shop?token=secret`,
      `${origin}/a/demo-shop#fragment`,
      `${origin}/a/%2e%2e/private`,
    ]) {
      expect(safeShareAssistantUrl(unsafe, origin)).toBeNull();
    }
  });

  it('produces a local PNG QR image without calling an external QR service', async () => {
    const image = await generateAssistantQrDataUrl(`${origin}/a/demo-shop`);
    expect(image.startsWith('data:image/png;base64,')).toBe(true);
    expect(
      Buffer.from(image.slice('data:image/png;base64,'.length), 'base64').subarray(0, 8),
    ).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});
