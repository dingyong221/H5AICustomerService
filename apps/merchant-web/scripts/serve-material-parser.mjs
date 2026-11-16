import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import {
  MAX_INPUT,
  MAX_TIME,
  MIME_TYPES,
  ParserFailure,
  parseNative,
  SOCKET_PATH,
} from './material-parser-runtime.mjs';

// Only a private, image-owned directory on the dedicated socket volume is used.
// Refuse symlinks/non-sockets and a live server; never unlink user-chosen paths.
const directory = await lstat(dirname(SOCKET_PATH));
if (
  !directory.isDirectory() ||
  directory.isSymbolicLink() ||
  directory.uid !== process.getuid() ||
  (directory.mode & 0o777) !== 0o700
)
  throw new Error('Unsafe parser socket directory');
try {
  const entry = await lstat(SOCKET_PATH);
  if (!entry.isSocket() || entry.uid !== process.getuid())
    throw new Error('Unsafe parser socket entry');
  const stale = await new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH);
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error('Parser socket busy'));
    });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', (error) => (error.code === 'ECONNREFUSED' ? resolve(true) : reject(error)));
  });
  if (!stale) throw new Error('Parser socket already active');
  await unlink(SOCKET_PATH);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

let active = false;
const controllers = new Set();
const arrivals = new WeakMap();
const reply = (res, status, payload) => {
  if (res.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': bytes.length,
    connection: 'close',
  });
  res.end(bytes);
};
const server = createServer(
  { maxHeaderSize: 2048, requestTimeout: MAX_TIME, headersTimeout: 5000 },
  async (req, res) => {
    const started = arrivals.get(req.socket) ?? Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, MAX_TIME - (Date.now() - started)),
    );
    controllers.add(controller);
    const abort = () => controller.abort();
    req.on('aborted', abort);
    res.on('close', abort); // A completed request can still disconnect during extraction.
    let admitted = false;
    try {
      if (
        req.method === 'GET' &&
        req.url === '/livez' &&
        !req.headers['content-length'] &&
        !req.headers['transfer-encoding']
      ) {
        reply(res, 200, { live: true });
        return;
      }
      if (
        req.method !== 'POST' ||
        req.url !== '/v1/extract' ||
        req.headers['transfer-encoding'] ||
        req.headers.expect ||
        !MIME_TYPES.includes(req.headers['content-type']) ||
        !/^[1-9][0-9]{0,7}$/u.test(req.headers['content-length'] ?? '') ||
        Number(req.headers['content-length']) > MAX_INPUT ||
        req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'content-length')
          .length !== 1
      ) {
        reply(res, 400, { error: 'invalid' });
        return;
      }
      if (active) {
        reply(res, 503, { error: 'busy' });
        return;
      }
      active = admitted = true;
      // Allocate once after admission; never retain a queue of multipart uploads.
      const bytes = Buffer.allocUnsafe(Number(req.headers['content-length']));
      let size = 0;
      const stopRead = () => req.destroy();
      controller.signal.addEventListener('abort', stopRead, { once: true });
      try {
        for await (const chunk of req) {
          if (controller.signal.aborted || size + chunk.length > bytes.length)
            throw new ParserFailure('invalid');
          chunk.copy(bytes, size);
          size += chunk.length;
        }
      } finally {
        controller.signal.removeEventListener('abort', stopRead);
      }
      if (!req.complete || size !== bytes.length) throw new ParserFailure('invalid');
      const text = await parseNative(bytes, req.headers['content-type'], {
        signal: controller.signal,
        timeoutMs: MAX_TIME - (Date.now() - started),
        concurrency: 1,
      });
      reply(res, 200, { text });
    } catch (error) {
      const code = controller.signal.aborted
        ? 'timeout'
        : error instanceof ParserFailure
          ? error.code
          : 'invalid';
      reply(res, code === 'timeout' ? 408 : 422, { error: code });
    } finally {
      // parseNative retains its own slot until child close even if this RPC was aborted.
      if (admitted) active = false;
      controllers.delete(controller);
      clearTimeout(timer);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
      // Let a rejected request's finite response flush before closing the socket.
      // Connection: close and the absolute socket deadline bound unread bodies.
      if (!req.complete && !res.writableEnded) req.destroy();
    }
  },
);
server.maxConnections = 8;
server.keepAliveTimeout = 1;
server.on('connection', (socket) => {
  arrivals.set(socket, Date.now());
  // Absolute connection deadline also bounds slow/incomplete headers. Idle
  // socket timeouts alone could be kept alive forever with occasional bytes.
  const timer = setTimeout(() => socket.destroy(), MAX_TIME);
  socket.once('close', () => clearTimeout(timer));
});
server.on('checkContinue', (_req, res) => reply(res, 400, { error: 'invalid' }));
server.on('clientError', (_error, socket) => socket.destroy());
server.listen(SOCKET_PATH, async () => {
  await chmod(SOCKET_PATH, 0o600);
});
const stop = () => {
  for (const controller of controllers) controller.abort();
  server.close();
  server.closeAllConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
