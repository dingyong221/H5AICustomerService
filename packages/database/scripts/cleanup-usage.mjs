import { loadDatabaseConfig, MySqlGrowthUsageRepository } from '../dist/index.js';
if (process.argv.slice(2).join(' ') !== '--run') throw Error('Explicit --run required');
const loaded = loadDatabaseConfig();
if (!loaded.configured) throw Error('Database not configured');
console.log(
  JSON.stringify({
    deleted: await new MySqlGrowthUsageRepository(loaded.config).cleanupExpired(),
    scope: 'only-expired-new-usage-data',
    at: new Date().toISOString(),
  }),
);
