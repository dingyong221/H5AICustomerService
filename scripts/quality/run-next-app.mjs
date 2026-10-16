import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Portable test/build launcher: resolves the app's locked Next install without relying
// on shell shims or Windows permission to recreate pnpm's optional symlinks.
const [app, action, port] = process.argv.slice(2);
if (
  !['merchant-web', 'consumer-h5', 'ops-web'].includes(app) ||
  !['build', 'start', 'dev'].includes(action) ||
  (port !== undefined &&
    (!/^[0-9]{1,5}$/u.test(port) || Number(port) < 1024 || Number(port) > 65535))
) {
  throw new Error(
    'Usage: run-next-app.mjs <merchant-web|consumer-h5|ops-web> <build|start|dev> [port]',
  );
}
const appRoot = fileURLToPath(new URL(`../../apps/${app}/`, import.meta.url));
const require = createRequire(new URL(`../../apps/${app}/package.json`, import.meta.url));
const cli = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [cli, action, ...(port ? ['--port', port] : [])], {
  cwd: appRoot,
  stdio: 'inherit',
  shell: false,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => {
  process.stderr.write('Could not start the locked Next runtime.\n');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
