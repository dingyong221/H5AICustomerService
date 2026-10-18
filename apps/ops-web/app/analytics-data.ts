import { loadDatabaseConfig, MySqlPlatformAnalyticsRepository } from '@h5cs/database';

export function analyticsRepository(): MySqlPlatformAnalyticsRepository | null {
  try {
    const database = loadDatabaseConfig();
    return database.configured ? new MySqlPlatformAnalyticsRepository(database.config) : null;
  } catch {
    return null;
  }
}
