import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), request: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:http', () => ({ request: mocks.request }));

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn(() => true);
  mocks.spawn.mockReturnValueOnce(child);
  return child;
}
beforeEach(() => {
  vi.resetModules();
  mocks.spawn.mockReset();
  mocks.request.mockReset();
  vi.stubEnv('H5CS_MATERIAL_PARSER_MODE', 'local');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('owned material child process lifecycle', () => {
  it('does not pass filenames, secrets, shell flags or unrestricted environment', async () => {
    const child = fakeChild();
    const { parseMaterial } = await import('./material-parser');
    const result = parseMaterial('private-customer-name.txt', Buffer.from('retail'));
    const [, args, options] = mocks.spawn.mock.calls[0]!;
    expect(args).toEqual([
      '--max-old-space-size=256',
      expect.stringMatching(/extract-material\.mjs$/u),
      'text/plain',
    ]);
    expect(options).not.toHaveProperty('shell');
    expect(Object.keys(options.env)).not.toEqual(
      expect.arrayContaining(['DATABASE_URL', 'QWEN_API_KEY', 'NODE_OPTIONS']),
    );
    expect(Object.keys(options.env).sort()).toEqual(
      ['NODE_ENV', 'PATH', 'SystemRoot', 'TEMP', 'TMP'].sort(),
    );
    expect(options.windowsHide).toBe(true);
    child.stdout.end(JSON.stringify({ text: 'retail' }));
    child.emit('close', 0);
    await expect(result).resolves.toBe('retail');
  });

  it('kills on timeout but holds its slot until that owned process has closed', async () => {
    vi.useFakeTimers();
    const firstChild = fakeChild(),
      secondChild = fakeChild();
    const { parseMaterial } = await import('./material-parser');
    const first = parseMaterial('one.txt', Buffer.from('one'));
    const second = parseMaterial('two.txt', Buffer.from('two'));
    const rejected = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(20000);
    expect(firstChild.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(secondChild.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await expect(parseMaterial('three.txt', Buffer.from('three'))).rejects.toThrow(/繁忙/u);
    firstChild.emit('close', null);
    secondChild.emit('close', null);
    expect((await rejected).every((entry) => entry.status === 'rejected')).toBe(true);
    const fresh = fakeChild();
    const fourth = parseMaterial('four.txt', Buffer.from('four'));
    fresh.stdout.end(JSON.stringify({ text: 'four' }));
    fresh.emit('close', 0);
    await expect(fourth).resolves.toBe('four');
  });

  it('releases a failed spawn on close and prevents malformed or overflowing output', async () => {
    const { parseMaterial } = await import('./material-parser');
    const failed = fakeChild();
    const first = parseMaterial('one.txt', Buffer.from('one'));
    const caught = expect(first).rejects.toThrow(/暂不可用/u);
    failed.emit('error', new Error('synthetic spawn failure'));
    failed.emit('close', -1);
    await caught;
    for (const payload of ['not-json', JSON.stringify({ text: ' ' }), 'x'.repeat(150001)]) {
      const child = fakeChild();
      const result = parseMaterial('one.txt', Buffer.from('one'));
      const rejection = expect(result).rejects.toThrow(/无效|过多/u);
      child.stdout.end(payload);
      child.emit('close', 0);
      await rejection;
    }
  });
  it('cancels an owned child and never starts an already aborted request', async () => {
    const { parseMaterial } = await import('./material-parser');
    const controller = new AbortController();
    const child = fakeChild();
    const result = parseMaterial('one.txt', Buffer.from('one'), { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow(/中断/u);
    controller.abort();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    child.emit('close', null);
    await rejected;
    await expect(
      parseMaterial('two.txt', Buffer.from('two'), { signal: controller.signal }),
    ).rejects.toThrow(/中断/u);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});

function fakeRequest() {
  const req = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  req.end = vi.fn();
  req.destroy = vi.fn();
  mocks.request.mockReturnValueOnce(req);
  return req;
}
function response(
  req: EventEmitter,
  payload: string,
  options: {
    status?: number;
    length?: string;
    type?: string;
    chunked?: boolean;
    duplicate?: boolean;
  } = {},
) {
  const res = Object.assign(new PassThrough(), {
    statusCode: options.status ?? 200,
    complete: true,
    headers: {
      'content-type': options.type ?? 'application/json',
      'content-length': options.length ?? String(Buffer.byteLength(payload)),
      ...(options.chunked ? { 'transfer-encoding': 'chunked' } : {}),
    },
    rawHeaders: [
      'Content-Length',
      String(Buffer.byteLength(payload)),
      ...(options.duplicate ? ['Content-Length', String(Buffer.byteLength(payload))] : []),
    ],
  });
  req.emit('response', res);
  res.end(payload);
}
describe('isolated parser transport fails closed', () => {
  it('uses only the fixed socket and never spawns a local fallback on connection failure', async () => {
    vi.stubEnv('H5CS_MATERIAL_PARSER_MODE', 'isolated');
    vi.stubEnv('H5CS_MATERIAL_PARSER_SOCKET', 'http://untrusted.invalid/path');
    const req = fakeRequest();
    const { parseMaterial } = await import('./material-parser');
    const result = parseMaterial('private-name.txt', Buffer.from('test'));
    expect(mocks.request).toHaveBeenCalledWith({
      socketPath: '/run/h5cs-material-parser/parser.sock',
      path: '/v1/extract',
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'text/plain', 'content-length': 4, connection: 'close' },
    });
    const rejected = expect(result).rejects.toThrow(/暂不可用/u);
    req.emit('error', new Error('synthetic unavailable'));
    await rejected;
    expect(mocks.spawn).not.toHaveBeenCalled();
    vi.stubEnv('H5CS_MATERIAL_PARSER_MODE', 'typo');
    await expect(parseMaterial('one.txt', Buffer.from('one'))).rejects.toThrow(/暂不可用/u);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('accepts a bounded response and rejects malformed protocol or arbitrary error text', async () => {
    vi.stubEnv('H5CS_MATERIAL_PARSER_MODE', 'isolated');
    const { parseMaterial } = await import('./material-parser');
    for (const options of [
      {},
      { chunked: true },
      { duplicate: true },
      { length: '150001' },
      { type: 'text/html' },
      { length: '1' },
    ]) {
      const req = fakeRequest();
      const result = parseMaterial('one.txt', Buffer.from('one'));
      const check = Object.keys(options).length
        ? expect(result).rejects.toThrow()
        : expect(result).resolves.toBe('one');
      response(req, JSON.stringify({ text: 'one' }), options);
      await check;
    }
    const req = fakeRequest();
    const result = parseMaterial('one.txt', Buffer.from('one'));
    const rejected = expect(result).rejects.toThrow(/无效/u);
    response(req, JSON.stringify({ error: 'private-native-detail' }), { status: 422 });
    await rejected;
  });
  it('destroys RPC on cancellation or the remaining batch deadline', async () => {
    vi.useFakeTimers();
    vi.stubEnv('H5CS_MATERIAL_PARSER_MODE', 'isolated');
    const { parseMaterial } = await import('./material-parser');
    const controller = new AbortController();
    const req = fakeRequest();
    const result = parseMaterial('one.txt', Buffer.from('one'), { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow(/中断/u);
    controller.abort();
    await rejected;
    expect(req.destroy).toHaveBeenCalledOnce();
    const req2 = fakeRequest();
    const result2 = parseMaterial('two.txt', Buffer.from('two'), { timeoutMs: 100 });
    const rejected2 = expect(result2).rejects.toThrow(/超时/u);
    await vi.advanceTimersByTimeAsync(100);
    await rejected2;
    expect(req2.destroy).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
