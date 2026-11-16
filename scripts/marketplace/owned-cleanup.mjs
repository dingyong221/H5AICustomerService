import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';

// Attach at spawn time: exitCode alone does not prove that stdio has closed.
export function observeOwnedChild(child) {
  const state = { closed: false, exitCode: null, signalCode: null, error: null };
  state.completion = new Promise((resolve) => {
    child.on('error', (error) => {
      state.error = error.message;
    });
    child.once('close', (code, signal) => {
      Object.assign(state, { closed: true, exitCode: code, signalCode: signal });
      resolve(state);
    });
  });
  return state;
}

async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Commands here contain only owned IDs/PIDs, never credentials.
export async function cleanupCommand(executable, args, { timeoutMs = 5000 } = {}) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const lifecycle = observeOwnedChild(child);
  let stdout = '',
    stderr = '',
    timedOut = false;
  child.stdout.on('data', (data) => {
    stdout = (stdout + data).slice(-32768);
  });
  child.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-32768);
  });
  try {
    await bounded(lifecycle.completion, timeoutMs);
  } catch {
    timedOut = true;
    child.kill('SIGKILL');
    await bounded(lifecycle.completion, 1000).catch(() => {});
    if (!lifecycle.closed) {
      child.unref();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
  return {
    executable,
    args,
    pid: child.pid ?? null,
    stdout,
    stderr,
    timedOut,
    closed: lifecycle.closed,
    exitCode: lifecycle.exitCode,
    signalCode: lifecycle.signalCode,
    error: lifecycle.error,
    ok: lifecycle.closed && lifecycle.exitCode === 0 && !lifecycle.error && !timedOut,
  };
}

export async function stopOwnedChild(record, { timeoutMs = 5000, waitOnly = false } = {}) {
  const { child, lifecycle } = record;
  const result = { name: record.name, pid: child.pid ?? null, termination: null, timedOut: false };
  if (!lifecycle.closed && child.exitCode === null && child.signalCode === null && child.pid) {
    if (!waitOnly) {
      try {
        result.termination =
          process.platform === 'win32'
            ? await cleanupCommand('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                timeoutMs,
              })
            : { signal: 'SIGTERM', ok: child.kill('SIGTERM') };
      } catch (error) {
        result.termination = { ok: false, error: error.message };
      }
    }
  }
  try {
    await bounded(lifecycle.completion, timeoutMs);
  } catch {
    result.timedOut = true;
    // Escalate only this still-owned child; a forced fallback never passes cleanup.
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        result.forced = { signal: 'SIGKILL', accepted: child.kill('SIGKILL') };
      } catch (error) {
        result.forced = { error: error.message };
      }
    }
    await bounded(lifecycle.completion, 1000).catch(() => {});
    if (!lifecycle.closed) {
      child.unref();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
  Object.assign(result, {
    closeObserved: lifecycle.closed,
    exitCode: lifecycle.exitCode,
    signalCode: lifecycle.signalCode,
    error: lifecycle.error,
    stopped:
      lifecycle.closed && !lifecycle.error && !result.timedOut && result.termination?.ok !== false,
  });
  return result;
}

export async function shutdownOwnedMysql(name, connection, timeoutMs = 5000) {
  const result = { name, attempted: Boolean(connection), shutdownSucceeded: false, ended: false };
  if (!connection) return { ...result, error: 'Owned MySQL connection unavailable', ok: false };
  try {
    await bounded(connection.query({ sql: 'SHUTDOWN', timeout: timeoutMs }), timeoutMs);
    result.shutdownSucceeded = true;
  } catch (error) {
    result.error = error.message;
  }
  try {
    await bounded(connection.end(), timeoutMs);
    result.ended = true;
  } catch (error) {
    result.endError = error.message;
    connection.destroy();
  }
  result.ok = result.shutdownSucceeded && result.ended;
  return result;
}

const inspectFormat =
  '{"id":{{json .Id}},"runId":{{json (index .Config.Labels "h5cs.test.run")}},"running":{{json .State.Running}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}}}';

export async function inspectOwnedContainer(container, options = {}) {
  const { executable = 'docker', prefixArgs = [] } = options;
  const id = (await readFile(container.cidFile, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/u.test(id)) throw Error('Missing or invalid full owned container ID');
  const command = await cleanupCommand(executable, [
    ...prefixArgs,
    'inspect',
    '--format',
    inspectFormat,
    id,
  ]);
  if (!command.ok)
    throw Error(
      `Owned container inspect failed: ${command.stderr || command.error || command.exitCode}`,
    );
  const state = JSON.parse(command.stdout);
  if (state.id !== id || state.runId !== container.runId || typeof state.running !== 'boolean')
    throw Error('Owned container ID/run label mismatch; refusing mutation');
  return state;
}

export async function stopOwnedContainer(container, options = {}) {
  const result = { name: container.name, cidFile: container.cidFile, stopped: false };
  try {
    result.before = await inspectOwnedContainer(container, options);
    if (result.before.running) {
      const { executable = 'docker', prefixArgs = [] } = options;
      result.stop = await cleanupCommand(
        executable,
        [...prefixArgs, 'stop', '--time', '10', result.before.id],
        { timeoutMs: 12000 },
      );
    }
    result.after = await inspectOwnedContainer(container, options);
    result.stopped =
      result.after.running === false &&
      result.after.status === 'exited' &&
      result.after.exitCode === 0 &&
      result.stop?.ok !== false;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

export async function probeLoopbackPort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ host: '127.0.0.1', port, ...result });
    };
    socket.once('connect', () => finish({ free: false, observed: 'connected' }));
    socket.once('error', (error) =>
      finish({ free: error.code === 'ECONNREFUSED', observed: error.code }),
    );
    socket.setTimeout(timeoutMs, () => finish({ free: false, observed: 'timeout' }));
  });
}

export function cleanupExitCode(businessExitCode, receipt) {
  return businessExitCode || (receipt.stopped === true ? 0 : 1);
}

export async function cleanupOwnedResources({ children, databases, ports }) {
  const processes = [],
    mysql = [],
    containers = [];
  const servers = new Set(databases.map((database) => database.server));
  for (const record of [...children].reverse())
    if (!servers.has(record)) processes.push(await stopOwnedChild(record));
  for (const database of databases) {
    try {
      mysql.push(await shutdownOwnedMysql(database.name, database.connection));
    } catch (error) {
      mysql.push({ name: database.name, ok: false, error: error.message });
    }
    if (database.container) containers.push(await stopOwnedContainer(database.container));
    if (database.server) {
      const stopped = await stopOwnedChild(database.server, { waitOnly: true });
      // A normal database shutdown must also yield a successful server/attached CLI exit.
      if (stopped.exitCode !== 0) stopped.stopped = false;
      processes.push(stopped);
    }
  }
  const loopbackPorts = await Promise.all(ports.map((port) => probeLoopbackPort(port)));
  return {
    cleanupAttempted: true,
    processes,
    mysql,
    containers,
    loopbackPorts,
    stopped:
      processes.every((record) => record.stopped) &&
      mysql.every((record) => record.ok) &&
      containers.every((record) => record.stopped) &&
      loopbackPorts.every((record) => record.free),
    productionTouched: false,
  };
}
