import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorkerApplication } from '../src/worker-application.js';

vi.mock('../src/conversation-dispatch.js', () => ({
  createConversationDispatch: () => ({ configured: false, reason: 'synthetic entry point' }),
}));
vi.mock('../src/worker-application.js', () => ({ startWorkerApplication: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

describe('service process shutdown', () => {
  it.each(['drained', 'failed', 'hung'] as const)(
    'exits the service process after %s cleanup instead of retaining a DB socket',
    async (outcome) => {
      vi.useFakeTimers();
      const handlers = new Map<string, () => void>();
      const originalOnce = process.once.bind(process);
      vi.spyOn(process, 'once').mockImplementation((event, listener) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          handlers.set(event, listener as () => void);
          return process;
        }
        return originalOnce(event, listener);
      });
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stop = vi.fn(() =>
        outcome === 'hung'
          ? new Promise<void>(() => undefined)
          : outcome === 'failed'
            ? Promise.reject(new Error('synthetic cleanup failure'))
            : Promise.resolve(),
      );
      vi.mocked(startWorkerApplication).mockResolvedValue({ server: {} as never, stop });
      const entrypoint = '../src/main.js';
      await import(entrypoint);
      handlers.get('SIGTERM')!();
      handlers.get('SIGINT')!();
      await vi.advanceTimersByTimeAsync(outcome === 'hung' ? 95_000 : 0);
      expect(stop).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(outcome === 'drained' ? 0 : 1);
    },
  );
});
