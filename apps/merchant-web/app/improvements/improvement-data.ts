import { loadDatabaseConfig, MySqlAssistantImprovementRepository } from '@h5cs/database';
import type { ImprovementList } from '@h5cs/domain';

/** Only call after resolving the current primary merchant session. Failures are not zero counts. */
export async function readImprovements(
  merchantId: string,
  merchantUserId: string,
  assistantId?: string,
): Promise<ImprovementList | null> {
  const database = loadDatabaseConfig();
  if (!database.configured) return null;
  try {
    return await new MySqlAssistantImprovementRepository(database.config).list({
      merchantId,
      merchantUserId,
      ...(assistantId ? { assistantId } : {}),
    });
  } catch {
    return null;
  }
}
