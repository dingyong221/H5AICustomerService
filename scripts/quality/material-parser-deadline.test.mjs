// Real loopback HTTP against the broker handler and deadline callbacks. This is
// portable protocol evidence, not Linux socket permissions or cgroup evidence.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import {
  MAX_INPUT,
  MIME_TYPES,
  ParserFailure,
} from '../../apps/merchant-web/scripts/material-parser-runtime.mjs';

const source = await readFile(
  new URL('../../apps/merchant-web/scripts/serve-material-parser.mjs', import.meta.url),
  'utf8',
);
const start = source.indexOf('let active = false;');
const end = source.indexOf('server.listen(SOCKET_PATH');
assert(start > 0 && end > start, 'broker handler boundaries changed');
// Omit only filesystem startup/listen/signal wiring, bind a random loopback port,
// and shorten the injected budget/header timeout. All deadline callbacks remain
// the actual source. The native extractor is replaced with a cancellable hang.
const handler = source.slice(start, end).replace('headersTimeout: 5000', 'headersTimeout: 50');
const budget = 300;
async function broker(t) {
  const calls = [];
  let server;
  runInNewContext(`${handler}\n__listen(server);`, {
    createServer,
    MAX_INPUT,
    MAX_TIME: budget,
    MIME_TYPES,
    ParserFailure,
    AbortController,
    Buffer,
    Date,
    setTimeout,
    clearTimeout,
    __listen: (value) => (server = value),
    parseNative: (bytes, _mime, { signal, timeoutMs }) => {
      const call = { body: bytes.toString(), aborted: false, timeoutMs };
      calls.push(call);
      if (call.body !== 'hang') return Promise.resolve(call.body);
      return new Promise((_resolve, reject) => {
        const stop = () => {
          call.aborted = true;
          reject(new ParserFailure('cancelled'));
        };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, port: server.address().port, calls };
}
function post(port, text) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/extract',
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'text/plain',
          'content-length': Buffer.byteLength(text),
          connection: 'close',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks)) }),
        );
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}
test('absolute child deadline aborts work and flushes timeout before socket close', async (t) => {
  const { port, calls } = await broker(t);
  const began = performance.now();
  assert.deepEqual(await post(port, 'hang'), { status: 408, payload: { error: 'timeout' } });
  const elapsed = performance.now() - began;
  assert(elapsed >= budget - 30 && elapsed < budget + 500, `deadline elapsed ${elapsed}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].aborted, true);
  assert(calls[0].timeoutMs > 0 && calls[0].timeoutMs <= budget);
  assert.deepEqual(await post(port, 'recovered'), {
    status: 200,
    payload: { text: 'recovered' },
  });
});
test('slow body stays bounded by the absolute deadline and releases admission', async (t) => {
  const { port, calls } = await broker(t);
  const began = performance.now();
  await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let wire = '';
    const watchdog = setTimeout(() => {
      socket.destroy();
      reject(new Error('body was not bounded'));
    }, budget + 700);
    socket.on('connect', () =>
      socket.write(
        'POST /v1/extract HTTP/1.1\r\nHost: local\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\nx',
      ),
    );
    socket.on('data', (chunk) => (wire += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(watchdog);
      assert(!wire.includes('200 OK'));
      resolve();
    });
  });
  const elapsed = performance.now() - began;
  assert(elapsed >= budget - 30 && elapsed < budget + 500, `body elapsed ${elapsed}`);
  assert.equal(calls.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await post(port, 'recovered')).status, 200);
});
test('admission rejects overlap and disconnect aborts work before the deadline', async (t) => {
  const { port, calls } = await broker(t);
  const socket = connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(
    'POST /v1/extract HTTP/1.1\r\nHost: local\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nhang',
  );
  for (let i = 0; i < 40 && !calls.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 1, 'request did not reach native extraction');
  assert.deepEqual(await post(port, 'overlap'), { status: 503, payload: { error: 'busy' } });
  socket.destroy();
  for (let i = 0; i < 20 && !calls[0].aborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls[0].aborted, true);
  assert.equal((await post(port, 'recovered')).status, 200);
});
