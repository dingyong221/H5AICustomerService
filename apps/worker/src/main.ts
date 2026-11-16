import { WorkerHealth } from './worker-health.js';
import { createConversationDispatch } from './conversation-dispatch.js';
import { createPreviewService } from './preview-service.js';
import { startWorkerApplication } from './worker-application.js';
import {
  loadDatabaseConfig,
  MySqlRuntimeExecutionControlRepository,
  MySqlModelCallAttemptRepository,
} from '@h5cs/database';
import { createRuntimeObservation } from './runtime-observation.js';

const parseInteger = (name: string, value: string | undefined, fallback: number): number => {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a positive integer no greater than 65535`);
  }
  return parsed;
};

const main = async (): Promise<void> => {
  const health = new WorkerHealth();
  const probeIntervalMs = parseInteger(
    'WORKER_POLL_INTERVAL_MS',
    process.env['WORKER_POLL_INTERVAL_MS'],
    5_000,
  );
  const dispatch = createConversationDispatch();
  const database = loadDatabaseConfig();
  const controls = database.configured
    ? new MySqlRuntimeExecutionControlRepository(database.config)
    : null;
  const attempts = database.configured
    ? new MySqlModelCallAttemptRepository(database.config)
    : null;
  const observation =
    dispatch.configured && controls && attempts
      ? createRuntimeObservation(process.env, {
          runtime: dispatch.runtime,
          controlEnabled: process.env['RUNTIME_EXECUTION_CONTROL_ENABLED'] === 'true',
          globalState: async () => (await controls.read({ kind: 'global' })).state,
          risk: () => attempts.unknownRiskCount(),
        })
      : null;

  const host = process.env['WORKER_HEALTH_HOST'] ?? '127.0.0.1';
  const port = parseInteger('WORKER_HEALTH_PORT', process.env['WORKER_HEALTH_PORT'], 3_011);
  const application = await startWorkerApplication({
    health,
    dispatch,
    observation,
    preview: dispatch.configured ? createPreviewService(process.env, dispatch.runtime) : null,
    host,
    port,
    probeIntervalMs,
  });

  process.stdout.write(`Worker health endpoint listening on ${host}:${String(port)}\n`);
  process.stdout.write(
    dispatch.configured
      ? 'Conversation job dispatch is configured.\n'
      : `Conversation job dispatch is disabled: ${dispatch.reason}.\n`,
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // Only the service entry point terminates the process. Hanging DB sockets
    // cannot keep it alive beyond the 90s best effort + 95s hard deadline.
    const watchdog = setTimeout(() => process.exit(1), 95_000);
    watchdog.unref();
    void application.stop().then(
      () => {
        clearTimeout(watchdog);
        process.exit(0);
      },
      () => {
        clearTimeout(watchdog);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
};

await main();
