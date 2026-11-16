#!/usr/bin/env node
import { workerRuntimeSnapshotSchema } from '../../packages/contracts/dist/index.js';
import { inspectRuntime } from './watchdog-core.mjs';

// On demand only: no schedule, writes, restart, resume, retry or model calls.
const args = process.argv.slice(2);
try {
  if (args.length !== 4 || args[0] !== '--url' || args[2] !== '--token-file')
    throw Error('arguments');
  const result = await inspectRuntime({
    url: args[1],
    tokenFile: args[3],
    parseSnapshot: (value) => workerRuntimeSnapshotSchema.parse(value),
  });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.status === 'healthy' ? 0 : 1;
} catch {
  // Do not print provider data, URL, file contents, token or an untrusted body.
  process.stdout.write(
    JSON.stringify({ status: 'unavailable', code: 'OBSERVATION_FAILED', actionsExecuted: [] }) +
      '\n',
  );
  process.exitCode = 2;
}
