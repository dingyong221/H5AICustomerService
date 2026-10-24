import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['integration/**/*.integration.ts'],
    // Files share one disposable MySQL database. Parallel account-claim fixture
    // setup can contend on absent-credential gap locks before the scenario starts.
    // Serialize files only; explicit Promise.all concurrency inside tests remains.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
