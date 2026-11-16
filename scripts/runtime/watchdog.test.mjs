import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluateSnapshot,
  inspectRuntime,
  internalSnapshotUrl,
  loadObservationToken,
} from './watchdog-core.mjs';

const token = 'synthetic_' + 'x'.repeat(33);
const folder = await mkdtemp(join(tmpdir(), 'h5cs-observation-fixture-'));
const tokenFile = join(folder, 'observation-token');
await writeFile(tokenFile, token);
const now = Date.now();
const snapshot = () => ({
  schemaVersion: 1,
  instanceId: 'worker_' + 'a'.repeat(32),
  startedAt: new Date(now - 1000).toISOString(),
  observedAt: new Date(now).toISOString(),
  localModelActive: 0,
  localQueued: 0,
  accepting: true,
  capacity: 2,
  managementCapacity: 1,
  controlEnabled: true,
  controlSchemaReady: true,
  globalControlState: 'active',
  unresolvedRiskCount: 0,
  riskProbeAt: new Date(now).toISOString(),
});
async function fixture(handler, run) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/internal/runtime-snapshot`;
  try {
    await run(url, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
const parseSnapshot = (value) => {
  assert.equal(value.schemaVersion, 1);
  assert.equal(typeof value.localModelActive, 'number');
  return value;
};
test('only the fixed private observation endpoint is allowed', () => {
  for (const value of [
    'https://worker/internal/runtime-snapshot',
    'http://example.com/internal/runtime-snapshot',
    'http://worker/internal/preview',
    'http://worker/internal/runtime-snapshot?token=secret',
    'http://user:password@worker/internal/runtime-snapshot',
    'http://worker/internal/runtime-snapshot#x',
  ])
    assert.throws(() => internalSnapshotUrl(value));
  assert.equal(
    internalSnapshotUrl('http://worker:3011/internal/runtime-snapshot').hostname,
    'worker',
  );
});
test('only bounded independent token text is accepted', async () => {
  assert.equal(await loadObservationToken(tokenFile), token);
  for (const [name, contents] of [
    ['huge', 'x'.repeat(513)],
    ['invalid-text', 'synthetic invalid token text '.repeat(3)],
    ['small', 'short'],
  ]) {
    const file = join(folder, name);
    await writeFile(file, contents);
    await assert.rejects(loadObservationToken(file));
  }
});
test('real HTTP request is GET only, token is header only, returned report contains no secret', async () => {
  await fixture(
    (req, res) => {
      assert.equal(req.headers['x-h5cs-observation-token'], token);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(snapshot()));
    },
    async (url, requests) => {
      const result = await inspectRuntime({ url, tokenFile, parseSnapshot, now });
      assert.equal(result.status, 'healthy');
      assert.deepEqual(result.actionsExecuted, []);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'GET');
      assert.equal(requests[0].url, '/internal/runtime-snapshot');
      assert(!JSON.stringify(result).includes(token));
    },
  );
});
test('paused and unknown risk are observations and never cause a recovery request', async () => {
  await fixture(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ...snapshot(),
          globalControlState: 'manually_stopped',
          unresolvedRiskCount: 1,
        }),
      );
    },
    async (url, requests) => {
      const report = await inspectRuntime({ url, tokenFile, parseSnapshot, now });
      assert.equal(report.status, 'attention');
      assert(report.issues.includes('global_manually_stopped'));
      assert(report.issues.includes('unresolved_supplier_risk'));
      assert.equal(requests.length, 1);
      assert.deepEqual(report.actionsExecuted, []);
    },
  );
});
test('stale risk or snapshot, missing control schema and unavailable probe cannot appear healthy', () => {
  for (const changes of [
    { observedAt: new Date(now - 20000).toISOString() },
    { riskProbeAt: new Date(now - 61000).toISOString() },
    { controlSchemaReady: false },
    { globalControlState: null },
    { unresolvedRiskCount: null },
    { accepting: false },
  ])
    assert.equal(evaluateSnapshot({ ...snapshot(), ...changes }, { now }).status, 'attention');
});
test('untrusted error bodies, malformed JSON and oversized bodies are not observations', async () => {
  for (const [status, body] of [
    [404, 'secret detail'],
    [200, 'not json'],
    [200, 'x'.repeat(16385)],
    [302, 'redirect'],
  ]) {
    await fixture(
      (req, res) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.setHeader('location', 'http://example.com');
        res.end(body);
      },
      async (url) => {
        await assert.rejects(inspectRuntime({ url, tokenFile, parseSnapshot, now }));
      },
    );
  }
});
test('the single deadline covers a response body that never finishes', async () => {
  await fixture(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.write('{');
    },
    async (url) => {
      const started = Date.now();
      await assert.rejects(inspectRuntime({ url, tokenFile, parseSnapshot, timeoutMs: 60 }));
      assert(Date.now() - started < 2000);
    },
  );
});

test('built CLI validates the shared strict schema and prints only its safe report', async () => {
  const cli = async (url) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./watchdog.mjs', import.meta.url)),
        '--url',
        url,
        '--token-file',
        tokenFile,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b;
      if (stdout.length > 32768) child.kill();
    });
    child.stderr.on('data', (b) => {
      stderr += b;
      if (stderr.length > 32768) child.kill();
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(stderr, '');
    assert(!stdout.includes(token));
    return { code, result: JSON.parse(stdout) };
  };
  await fixture(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(snapshot()));
    },
    async (url) => {
      const actual = await cli(url);
      assert.equal(actual.code, 0);
      assert.equal(actual.result.status, 'healthy');
    },
  );
  await fixture(
    (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ...snapshot(), untrustedSecret: token }));
    },
    async (url) => {
      const actual = await cli(url);
      assert.equal(actual.code, 2);
      assert.deepEqual(actual.result, {
        status: 'unavailable',
        code: 'OBSERVATION_FAILED',
        actionsExecuted: [],
      });
    },
  );
});
