import { createHealthServer } from './health-server.js';
import { PollLoop } from './poll-loop.js';
import type { WorkerHealth } from './worker-health.js';
import type { ConversationDispatchResult } from './conversation-dispatch.js';
import type { PreviewService } from './preview-service.js';
import { ConversationScheduler } from './conversation-scheduler.js';
import { settlesWithin } from './shutdown-budget.js';
import { KnowledgeOrganizationScheduler } from './knowledge-organization-scheduler.js';

export async function startWorkerApplication(options: {
  health: WorkerHealth;
  dispatch: ConversationDispatchResult;
  preview: PreviewService | null;
  host: string;
  port: number;
  probeIntervalMs?: number;
  drainMs?: number;
  finalizationMs?: number;
  httpTimeoutMs?: number;
}) {
  const { health, dispatch } = options;
  let stopping = false;
  let conversationReady = false,
    knowledgeReady = !(dispatch.configured && dispatch.knowledgeProcessor);
  const readiness = () =>
    health.setConversationReady(conversationReady && knowledgeReady && !stopping);
  const scheduler = dispatch.configured
    ? new ConversationScheduler(dispatch.processor, dispatch.runtime, (ready) => {
        conversationReady = ready;
        readiness();
      })
    : null;
  const knowledgeScheduler =
    dispatch.configured && dispatch.knowledgeProcessor
      ? new KnowledgeOrganizationScheduler(
          dispatch.knowledgeProcessor,
          dispatch.runtime,
          (ready) => {
            knowledgeReady = ready;
            readiness();
          },
        )
      : null;
  const server = createHealthServer(health, options.preview, options.httpTimeoutMs);
  // Liveness responds while the first DB probe or model request is still pending.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  const probes = new PollLoop(options.probeIntervalMs ?? 5_000, async () => {
    await health.probeDatabase();
    if (!health.databaseAvailable() || !dispatch.configured || stopping) {
      health.setConversationReady(false);
      return;
    }
    scheduler?.start();
    knowledgeScheduler?.start();
  });
  void probes.runOnce().catch(() => health.setConversationReady(false));
  probes.start();
  let shutdown: Promise<void> | undefined;
  return {
    server,
    stop: (): Promise<void> => {
      shutdown ??= (async () => {
        stopping = true;
        health.setConversationReady(false);
        if (dispatch.configured) dispatch.runtime.stopAdmission();
        const close = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        });
        const drainMs = options.drainMs ?? 85_000;
        const finalizationMs = options.finalizationMs ?? 5_000;
        // Start every stop operation now. A hung read/claim/probe must not
        // postpone the model abort deadline or hold HTTP sockets forever.
        const cleanup = Promise.allSettled([
          scheduler?.stop(),
          knowledgeScheduler?.stop(),
          dispatch.configured ? dispatch.runtime.drain(drainMs, finalizationMs) : undefined,
          probes.stop(),
          close,
        ]);
        if (!(await settlesWithin(cleanup, drainMs + finalizationMs))) {
          server.closeAllConnections();
          return;
        }
        const failed = (await cleanup).find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      })();
      return shutdown;
    },
  };
}
