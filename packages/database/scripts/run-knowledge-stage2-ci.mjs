import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareStage2Baseline } from './prepare-knowledge-stage2-baseline.mjs';
// This runner neither creates accounts nor starts services. CI supplies a new
// empty database with only the dedicated account; tests fail before writing if
// its exact loopback URL/account/schema or emptiness check does not match.
const authoring = process.argv.length === 3 && process.argv[2] === '--authoring';
if ((!authoring && process.argv.length !== 2) || !process.env.H5CS_STAGE2_MYSQL_URL)
  throw Error('H5CS_STAGE2_MYSQL_URL for a dedicated empty test database is required');
const runRoot = await mkdtemp(join(tmpdir(), 'h5cs-stage2-ci-'));
const { legacyModule, baselineMigrations } = await prepareStage2Baseline(runRoot);
async function run(file) {
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', file], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_ENV: 'test',
      NODE_ENV: 'test',
      H5CS_STAGE2_BASELINE_MIGRATIONS: baselineMigrations,
      H5CS_STAGE2_LEGACY_READER: legacyModule,
    },
  });
  return await new Promise((ok, bad) => {
    child.once('error', bad);
    child.once('close', ok);
  });
}
let code = await run('test/knowledge-stage2.mysql.mjs');
if (code === 0 && authoring) code = await run('test/authoring-stage2.mysql.mjs');
process.stdout.write(
  JSON.stringify({
    runRoot,
    passed: code === 0,
    authoring,
    productionAccess: false,
    supplierCalled: false,
  }) + '\n',
);
process.exitCode = code ?? 1;
