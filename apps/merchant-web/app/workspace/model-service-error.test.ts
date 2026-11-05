import { describe, expect, it } from 'vitest';
import { checkMarketplaceModelError, MarketplaceModelError } from './model-service-error';
describe('safe product model status errors', () => {
  it('maps only the recognized product codes and never reflects worker diagnostics', async () => {
    for (const code of ['MARKETPLACE_QUOTA_EXHAUSTED', 'MARKETPLACE_NOT_ELIGIBLE']) {
      const response = Response.json(
        { error: { code, message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' } },
        { status: 403 },
      );
      try {
        await checkMarketplaceModelError(response);
        throw Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(MarketplaceModelError);
        expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_DIAGNOSTIC');
      }
    }
    await expect(
      checkMarketplaceModelError(
        Response.json({ error: { code: 'UNAVAILABLE', message: 'untrusted' } }, { status: 503 }),
      ),
    ).resolves.toBeUndefined();
  });
});
