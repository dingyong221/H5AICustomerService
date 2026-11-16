import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  observeOwnedChild,
  stopOwnedChild,
  cleanupCommand,
  shutdownOwnedMysql,
  stopOwnedContainer,
  probeLoopbackPort,
  cleanupOwnedResources,
  cleanupExitCode,
} from './owned-cleanup.mjs';

async function fixture(t, body) {
  const child = spawn(process.execPath, ['-e', body], { stdio: ['pipe', 'pipe', 'pipe'] });
  const record = { name: 'owned-test-child', child, lifecycle: observeOwnedChild(child) };
  t.after(async () => {
    if (!record.lifecycle.closed) {
      child.kill('SIGKILL');
      await record.lifecycle.completion;
    }
  });
  await once(child.stdout, 'data');
  return record;
}

test('waits for a real delayed close rather than sampling immediately', async (t) => {
  const record = await fixture(
    t,
    `process.stdin.resume();
    process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));
    console.log('ready');`,
  );
  record.child.stdin.end();
  const started = Date.now();
  const result = await stopOwnedChild(record, { waitOnly: true, timeoutMs: 2000 });
  assert.equal(result.stopped, true);
  assert.equal(result.closeObserved, true);
  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - started >= 150);
});

test('exact owned child termination observes close on the host platform', async (t) => {
  const record = await fixture(t, `setInterval(() => {}, 1000); console.log('ready');`);
  const result = await stopOwnedChild(record);
  assert.equal(result.stopped, true, JSON.stringify(result));
  assert.equal(result.closeObserved, true);
  assert.equal(result.termination.ok, true);
});

test('a real child exceeding the deadline stays failed even after owned SIGKILL fallback', async (t) => {
  const record = await fixture(t, `setInterval(() => {}, 1000); console.log('ready');`);
  const result = await stopOwnedChild(record, { waitOnly: true, timeoutMs: 50 });
  assert.equal(result.stopped, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.forced.accepted, true);
  assert.equal(result.closeObserved, true);
  assert.equal(cleanupExitCode(0, result), 1);
});

test(
  'Linux SIGTERM handler closes late and refusal to exit cannot pass',
  {
    skip: process.platform === 'win32' ? 'POSIX signal semantics; runs on Linux CI' : false,
  },
  async (t) => {
    const delayed = await fixture(
      t,
      `setInterval(() => {}, 1000);
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); console.log('ready');`,
    );
    const started = Date.now();
    assert.equal((await stopOwnedChild(delayed)).stopped, true);
    assert.ok(Date.now() - started >= 150);
    const refused = await fixture(
      t,
      `setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {}); console.log('ready');`,
    );
    const result = await stopOwnedChild(refused, { timeoutMs: 100 });
    assert.equal(result.termination.ok, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.stopped, false);
  },
);

test('already closed nonzero child remains stopped and preserves its actual business exit', async (t) => {
  const record = await fixture(t, `console.log('ready'); setTimeout(() => process.exit(7), 50);`);
  await record.lifecycle.completion;
  const result = await stopOwnedChild(record);
  assert.equal(result.stopped, true);
  assert.equal(result.exitCode, 7);
  assert.equal(result.termination, null);
  assert.equal(cleanupExitCode(7, { stopped: true }), 7);
  assert.equal(cleanupExitCode(7, { stopped: false }), 7);
});

test('actual CLI preserves rejection, missing executable and bounded timeout', async () => {
  const rejected = await cleanupCommand(process.execPath, ['-e', 'process.exit(9)']);
  assert.equal(rejected.exitCode, 9);
  assert.equal(rejected.ok, false);
  const missing = await cleanupCommand(join(tmpdir(), 'h5cs-nonexistent-owned-command'), []);
  assert.match(missing.error, /ENOENT/u);
  assert.equal(missing.closed, true);
  assert.equal(missing.ok, false);
  const timed = await cleanupCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 50,
  });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.ok, false);
  assert.equal(timed.closed, true);
});

test('MySQL shutdown rejection and end errors remain separate failed evidence', async () => {
  const calls = [];
  const success = await shutdownOwnedMysql('owned', {
    async query(options) {
      calls.push(options.sql);
    },
    async end() {
      calls.push('end');
    },
  });
  assert.equal(success.ok, true);
  assert.deepEqual(calls, ['SHUTDOWN', 'end']);
  const failure = await shutdownOwnedMysql('owned', {
    async query() {
      throw Error('shutdown denied');
    },
    async end() {
      throw Error('end failed');
    },
    destroy() {
      calls.push('destroy');
    },
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'shutdown denied');
  assert.equal(failure.endError, 'end failed');
  assert.equal(calls.at(-1), 'destroy');
  assert.equal((await shutdownOwnedMysql('missing', null)).ok, false);
  const timeout = await shutdownOwnedMysql(
    'unresponsive',
    { query: () => new Promise(() => {}), async end() {} },
    25,
  );
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /Timed out after 25ms/u);
  assert.equal(timeout.ended, true);
});

async function dockerFixture(t, changes = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'h5cs-owned-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = 'a'.repeat(64),
    statePath = join(dir, 'state.json');
  const state = {
    id,
    runId: 'test-run',
    running: true,
    status: 'running',
    exitCode: 0,
    ...changes,
  };
  await writeFile(statePath, JSON.stringify(state));
  const script = join(dir, 'docker-fixture.mjs');
  await writeFile(
    script,
    `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    const [file, ...args] = process.argv.slice(2);
    appendFileSync(file + '.calls', JSON.stringify(args) + '\\n');
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (args[0] === 'inspect') {
      if (state.inspectExit) process.exit(state.inspectExit);
      console.log(JSON.stringify(state));
    } else if (args[0] === 'stop') {
      if (state.stopExit) process.exit(state.stopExit);
      if (!state.stayRunning) { state.running = false; state.status = 'exited'; }
      writeFileSync(file, JSON.stringify(state));
      console.log(state.id);
    } else process.exit(99);`,
  );
  const cidFile = join(dir, 'owned.cid');
  await writeFile(cidFile, id);
  return {
    container: { name: 'synthetic-owned', cidFile, runId: 'test-run' },
    options: { executable: process.execPath, prefixArgs: [script, statePath] },
    calls: async () =>
      (await readFile(statePath + '.calls', 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

test('container CLI uses only full owned ID and verifies state after stop', async (t) => {
  const f = await dockerFixture(t);
  const result = await stopOwnedContainer(f.container, f.options);
  assert.equal(result.stopped, true);
  assert.equal(result.before.running, true);
  assert.equal(result.after.running, false);
  const calls = await f.calls();
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['inspect', 'stop', 'inspect'],
  );
  assert.deepEqual(calls[1], ['stop', '--time', '10', 'a'.repeat(64)]);
  const again = await stopOwnedContainer(f.container, f.options);
  assert.equal(again.stopped, true);
  assert.equal(again.stop, undefined);
});

test('container identity mismatch, stop rejection, missing inspect and running readback fail closed', async (t) => {
  for (const changes of [
    { runId: 'another-run' },
    { id: 'b'.repeat(64) },
    { stopExit: 8 },
    { inspectExit: 4 },
    { stayRunning: true },
    { exitCode: 137 },
  ]) {
    const f = await dockerFixture(t, changes);
    const result = await stopOwnedContainer(f.container, f.options);
    assert.equal(result.stopped, false, JSON.stringify({ changes, result }));
    if (changes.runId || changes.id || changes.inspectExit)
      assert.deepEqual(
        (await f.calls()).map((args) => args[0]),
        ['inspect'],
      );
    if (changes.stopExit) assert.equal(result.stop.exitCode, 8);
  }
  const missing = await stopOwnedContainer({
    name: 'no-id',
    cidFile: join(tmpdir(), 'h5cs-no-cid'),
    runId: 'test-run',
  });
  assert.equal(missing.stopped, false);
  assert.equal(missing.before, undefined);
});

test('loopback readback detects an occupied owned listener without stopping it', async (t) => {
  const server = createServer((socket) => socket.end());
  t.after(() => server.listening && server.close());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const occupied = await probeLoopbackPort(port);
  assert.equal(occupied.free, false);
  assert.equal(server.listening, true);
  const failed = await cleanupOwnedResources({ children: [], databases: [], ports: [port] });
  assert.equal(failed.stopped, false);
  assert.equal(cleanupExitCode(0, failed), 1);
  await new Promise((resolve) => server.close(resolve));
  const free = await probeLoopbackPort(port);
  assert.equal(free.free, true);
  assert.equal(free.observed, 'ECONNREFUSED');
});

test('actual CLI exit is nonzero for cleanup failure and preserves original business failure', async () => {
  const helperUrl = new URL('./owned-cleanup.mjs', import.meta.url).href;
  for (const [business, stopped, expected] of [
    [0, true, 0],
    [0, false, 1],
    [7, true, 7],
    [7, false, 7],
  ]) {
    const command = await cleanupCommand(process.execPath, [
      '--input-type=module',
      '-e',
      `import { cleanupExitCode } from ${JSON.stringify(helperUrl)};
       process.exitCode = cleanupExitCode(${business}, { stopped: ${stopped} });`,
    ]);
    assert.equal(command.exitCode, expected);
  }
});
