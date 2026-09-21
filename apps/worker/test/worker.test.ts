import { describe, expect, it, vi } from 'vitest';

import { livenessDataSchema, readinessDataSchema } from '@h5cs/contracts';

import { PollLoop } from '../src/poll-loop.js';
import { WorkerHealth } from '../src/worker-health.js';

describe('worker foundation', () => {
  it('runs an injected poll action without overlapping it', async () => {
    const action = vi.fn(async () => undefined);
    const loop = new PollLoop(1_000, action);

    await Promise.all([loop.runOnce(), loop.runOnce()]);
    await loop.stop();

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('is live but not ready when MySQL is unconfigured', async () => {
    const previous = process.env['MYSQL_DATABASE_URL'];
    delete process.env['MYSQL_DATABASE_URL'];

    try {
      const health = new WorkerHealth();
      await health.probeDatabase();

      expect(livenessDataSchema.parse(health.liveness()).status).toBe('ok');
      expect(readinessDataSchema.parse(health.readiness()).status).toBe('not_ready');
    } finally {
      if (previous !== undefined) process.env['MYSQL_DATABASE_URL'] = previous;
    }
  });
});
