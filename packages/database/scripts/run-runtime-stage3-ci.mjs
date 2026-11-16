import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.argv.length !== 2 || !process.env.H5CS_STAGE2_MYSQL_URL)
  throw Error('Dedicated empty stage2 CI database required');
const cwd = fileURLToPath(new URL('../', import.meta.url));
async function run(args, enabled) {
  const child = spawn(process.execPath, args, {
    cwd,
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_ENV: 'test',
      NODE_ENV: 'test',
      RUNTIME_EXECUTION_CONTROL_ENABLED: enabled,
    },
  });
  return new Promise((ok, bad) => {
    child.once('error', bad);
    child.once('close', ok);
  });
}
let code = await run(['scripts/run-knowledge-stage2-ci.mjs', '--authoring'], 'false');
if (code === 0)
  code = await run(['--test', '--test-concurrency=1', 'test/runtime-stage3.mysql.mjs'], 'true');
process.exitCode = code ?? 1;
