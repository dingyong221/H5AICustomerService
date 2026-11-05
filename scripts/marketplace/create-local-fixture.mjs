import { randomBytes } from 'node:crypto';
import {
  loadDatabaseConfig,
  marketplaceFixtureEnabled,
  MySqlMarketplaceRepository,
} from '../../packages/database/dist/index.js';

if (!marketplaceFixtureEnabled(process.env))
  throw new Error('Only the dedicated non-production loopback fixture environment is allowed');
const database = loadDatabaseConfig();
if (!database.configured) throw new Error('Dedicated local database required');
const repository = new MySqlMarketplaceRepository(database.config);
const code = await repository.createSyntheticGrant({
  subject: `synthetic-${randomBytes(12).toString('hex')}`,
});
// This is a ten-minute local test credential. Never embed it in a public QR or URL.
process.stdout.write(`LOCAL SYNTHETIC FIXTURE ONLY (10 minutes, model quota 0): ${code}\n`);
