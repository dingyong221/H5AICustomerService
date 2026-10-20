import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

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
});
afterEach(() => vi.useRealTimers());

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
});
