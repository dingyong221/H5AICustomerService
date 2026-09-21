import { createHealthServer } from './health-server.js';
import { PollLoop } from './poll-loop.js';
import { WorkerHealth } from './worker-health.js';

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

  // The first polling action only checks the fact-store dependency. Job claiming remains disabled
  // until a real MySQL lease repository and registered handlers are implemented.
  const pollLoop = new PollLoop(probeIntervalMs, () => health.probeDatabase());
  await pollLoop.runOnce();
  pollLoop.start();

  const server = createHealthServer(health);
  const host = process.env['WORKER_HEALTH_HOST'] ?? '127.0.0.1';
  const port = parseInteger('WORKER_HEALTH_PORT', process.env['WORKER_HEALTH_PORT'], 3_011);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  process.stdout.write(`Worker health endpoint listening on ${host}:${String(port)}\n`);
  process.stdout.write('Job dispatch is disabled until real lease storage and handlers exist.\n');

  const shutdown = async (): Promise<void> => {
    await pollLoop.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
};

await main();
