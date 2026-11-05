import { randomBytes } from 'node:crypto';

import {
  loadDatabaseConfig,
  MySqlConversationTurnJobRepository,
  MySqlMarketplaceRepository,
  type DatabaseConnectionConfig,
} from '@h5cs/database';

import {
  ChatCompletionsGenerator,
  loadChatCompletionsConfig,
} from './chat-completions-generator.js';
import {
  ConversationTurnProcessor,
  type ConversationTurnStore,
} from './conversation-turn-processor.js';

type DispatchDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  assertModelAccess?: (merchantId: string) => Promise<void>;
  reserveModelCall?: (merchantId: string, operation: string) => Promise<void>;
  storeFactory?: (database: DatabaseConnectionConfig) => ConversationTurnStore;
}>;

export type ConversationDispatchResult =
  | Readonly<{ configured: false; reason: string }>
  | Readonly<{ configured: true; processor: ConversationTurnProcessor }>;

export function createConversationDispatch(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: DispatchDependencies = {},
): ConversationDispatchResult {
  const model = loadChatCompletionsConfig(environment);
  if (!model.configured) return model;
  let database: ReturnType<typeof loadDatabaseConfig>;
  try {
    database = loadDatabaseConfig(environment);
  } catch {
    return { configured: false, reason: 'MYSQL_DATABASE_URL is invalid' };
  }
  if (!database.configured) return database;
  const store =
    dependencies.storeFactory?.(database.config) ??
    new MySqlConversationTurnJobRepository(database.config);
  const budget = new MySqlMarketplaceRepository(database.config);
  const generator = new ChatCompletionsGenerator(
    model.config,
    dependencies.fetchImpl,
    dependencies.reserveModelCall ??
      ((merchantId, operation) => budget.reserveModelCall(merchantId, operation)),
    dependencies.assertModelAccess ?? ((merchantId) => budget.assertModelAccess(merchantId)),
  );
  return {
    configured: true,
    processor: new ConversationTurnProcessor(
      store,
      generator,
      `worker_${randomBytes(16).toString('hex')}`,
    ),
  };
}
