import { describe, expect, it, vi } from 'vitest';
import { marketplaceFixtureEnabled } from '../src/marketplace-local-policy.js';
import {
  MarketplaceAccessError,
  MySqlMarketplaceRepository,
} from '../src/marketplace-repository.js';
import {
  parseAssistantDraft,
  validateAssistantDraft,
} from '../src/assistant-lifecycle-repository.js';
import { emptyMarketplaceDraft } from '../src/assistant-draft-records.js';

const environment = {
  H5CS_MARKETPLACE_MODE: 'local-fixture',
  NODE_ENV: 'test',
  APP_ENV: 'test',
  MERCHANT_PUBLIC_ORIGIN: 'http://127.0.0.1:3186',
  MYSQL_DATABASE_URL: 'mysql://h5cs_a6_test:synthetic@127.0.0.1:3306/h5cs_marketplace_a6_test',
};
describe('marketplace local fixture safety boundary', () => {
  it('allows only explicit local configuration and never production, remote origins or merchant databases', () => {
    expect(marketplaceFixtureEnabled(environment)).toBe(true);
    for (const patch of [
      { H5CS_MARKETPLACE_MODE: undefined },
      { NODE_ENV: 'production' },
      { APP_ENV: 'production' },
      { MERCHANT_PUBLIC_ORIGIN: 'https://h5cs.1rying.com' },
      { MERCHANT_PUBLIC_ORIGIN: 'http://127.0.0.1:3186/path' },
      { MYSQL_DATABASE_URL: 'mysql://h5cs_a6_test:synthetic@mysql/h5cs_marketplace_a6_test' },
      { MYSQL_DATABASE_URL: 'mysql://h5cs_a6_test:synthetic@127.0.0.1/h5cs_production' },
      { MYSQL_DATABASE_URL: 'mysql://root:synthetic@127.0.0.1/h5cs_marketplace_a6_test' },
    ])
      expect(marketplaceFixtureEnabled({ ...environment, ...patch })).toBe(false);
  });
  it('rejects disabled fixtures before any database read or write', async () => {
    const openConnection = vi.fn();
    const repository = new MySqlMarketplaceRepository(
      {
        openConnection,
        summary: { host: '127.0.0.1', database: 'h5cs_marketplace_a6_test', tlsRequested: false },
        toJSON: () => ({
          host: '127.0.0.1',
          database: 'h5cs_marketplace_a6_test',
          tlsRequested: false,
        }),
      },
      undefined,
      { ...environment, NODE_ENV: 'production' },
    );
    await expect(
      repository.createSyntheticGrant({ subject: 'synthetic-example' }),
    ).rejects.toBeInstanceOf(MarketplaceAccessError);
    await expect(
      repository.claimSynthetic({
        code: 'a'.repeat(43),
        phone: '13800138001',
        password: 'SYNTHETIC-password-001',
        requestId: 'test',
      }),
    ).rejects.toBeInstanceOf(MarketplaceAccessError);
    expect(openConnection).not.toHaveBeenCalled();
  });
  it('reads the exact unfilled seed for management, but rejects saving or confirming it as real merchant facts', () => {
    expect(parseAssistantDraft(JSON.stringify(emptyMarketplaceDraft))).toEqual(
      emptyMarketplaceDraft,
    );
    expect(() => validateAssistantDraft(emptyMarketplaceDraft)).toThrow();
    expect(() =>
      parseAssistantDraft({ ...emptyMarketplaceDraft, pricingSummary: '捏造价格' }),
    ).toThrow();
  });
});
