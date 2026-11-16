import { randomBytes } from 'node:crypto';

import {
  loadDatabaseConfig,
  MySqlConversationTurnJobRepository,
  MySqlMarketplaceRepository,
  MySqlModelCallAttemptRepository,
  MySqlKnowledgeOrganizationRepository,
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
import { ModelRuntime, type ModelAttemptStore } from './model-runtime.js';
import {
  KnowledgeOrganizationProcessor,
  type KnowledgeOrganizationStore,
} from './knowledge-organization-processor.js';

type DispatchDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  assertModelAccess?: (merchantId: string) => Promise<void>;
  reserveModelCall?: (merchantId: string, operation: string) => Promise<void>;
  storeFactory?: (database: DatabaseConnectionConfig) => ConversationTurnStore;
  runtime?: ModelRuntime;
  attempts?: ModelAttemptStore;
  knowledgeStoreFactory?: (database: DatabaseConnectionConfig) => KnowledgeOrganizationStore;
}>;

export type ConversationDispatchResult =
  | Readonly<{ configured: false; reason: string }>
  | Readonly<{
      configured: true;
      processor: ConversationTurnProcessor;
      runtime: ModelRuntime;
      knowledgeProcessor?: KnowledgeOrganizationProcessor;
    }>;

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
  const runtime =
    dependencies.runtime ??
    new ModelRuntime(dependencies.attempts ?? new MySqlModelCallAttemptRepository(database.config));
  const generator = new ChatCompletionsGenerator(
    model.config,
    dependencies.fetchImpl,
    undefined,
    dependencies.assertModelAccess ?? ((merchantId) => budget.assertModelAccess(merchantId)),
    runtime,
  );
  return {
    configured: true,
    runtime,
    processor: new ConversationTurnProcessor(
      store,
      generator,
      `worker_${randomBytes(16).toString('hex')}`,
    ),
    ...(environment['KNOWLEDGE_ASYNC_ENABLED'] === 'true'
      ? {
          knowledgeProcessor: new KnowledgeOrganizationProcessor(
            dependencies.knowledgeStoreFactory?.(database.config) ??
              new MySqlKnowledgeOrganizationRepository(database.config, true),
            generator,
            `knowledge_${randomBytes(16).toString('hex')}`,
          ),
        }
      : {}),
  };
}
