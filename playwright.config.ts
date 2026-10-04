import { createHash, randomBytes, scryptSync } from 'node:crypto';

import { defineConfig } from '@playwright/test';

const databaseUrl = process.env['H5CS_INTEGRATION_MYSQL_URL'];
if (!databaseUrl) throw new Error('Browser tests require the isolated integration database');
const target = new URL(databaseUrl);
if (
  target.protocol !== 'mysql:' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.pathname !== '/h5cs_integration_ci' ||
  target.username !== 'h5cs_ci' ||
  target.search !== '' ||
  target.hash !== ''
) {
  throw new Error('Browser tests only run against the dedicated loopback CI database');
}

const pathMode = process.env['H5CS_E2E_PATH_MODE'] ?? 'root';
if (pathMode !== 'root' && pathMode !== 'subpaths' && pathMode !== 'single_domain') {
  throw new Error('H5CS_E2E_PATH_MODE must be root, subpaths or single_domain');
}
const merchantBasePath = pathMode === 'root' ? '' : '/console';
const opsBasePath = pathMode === 'root' ? '' : '/ops';
const publicOrigin = 'http://127.0.0.1:3001';
const merchantOrigin = pathMode === 'single_domain' ? publicOrigin : 'http://127.0.0.1:3000';
const opsOrigin = pathMode === 'single_domain' ? publicOrigin : 'http://127.0.0.1:3002';

const operatorPassword = createHash('sha256')
  .update('h5cs-isolated-browser-operator:', 'utf8')
  .update(databaseUrl, 'utf8')
  .digest('base64url');
const operatorSalt = randomBytes(16);
const externalServices = process.env['H5CS_E2E_EXTERNAL_SERVICES'] === 'true';
if (externalServices && process.env['CI'] !== 'true') {
  throw new Error('External-image browser tests are restricted to CI');
}
const modelKey = externalServices
  ? createHash('sha256')
      .update('h5cs-isolated-browser-model:', 'utf8')
      .update(databaseUrl, 'utf8')
      .digest('base64url')
  : randomBytes(32).toString('base64url');
const previewToken = randomBytes(32).toString('base64url');
process.env['H5CS_E2E_OPERATOR_PASSWORD'] = operatorPassword;
const common = {
  MYSQL_DATABASE_URL: databaseUrl,
  H5CS_INTEGRATION_MYSQL_URL: databaseUrl,
};

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: { browserName: 'chromium', trace: 'off', screenshot: 'off', video: 'off' },
  webServer: [
    {
      command: 'node tests/e2e/fake-model.mjs',
      url: 'http://127.0.0.1:9020/healthz',
      env: { ...common, H5CS_E2E_MODEL_KEY: modelKey },
      reuseExistingServer: false,
    },
    ...(!externalServices
      ? [
          {
            command: 'pnpm --filter @h5cs/api start',
            url: 'http://127.0.0.1:4000/readyz',
            env: {
              ...common,
              NODE_ENV: 'test',
              HOST: '127.0.0.1',
              PORT: '4000',
              PUBLIC_CONVERSATION_ENABLED: 'true',
              CONSUMER_H5_ORIGIN: publicOrigin,
              VISITOR_CREDENTIAL_HMAC_KEY: randomBytes(32).toString('base64url'),
            },
            reuseExistingServer: false,
          },
        ]
      : []),
    ...(!externalServices
      ? [
          {
            command: 'pnpm --filter @h5cs/worker start',
            url: 'http://127.0.0.1:3011/readyz',
            env: {
              ...common,
              NODE_ENV: 'test',
              WORKER_HEALTH_HOST: '127.0.0.1',
              WORKER_POLL_INTERVAL_MS: '1000',
              CONVERSATION_WORKER_ENABLED: 'true',
              MODEL_PROVIDER: 'chat_completions',
              MODEL_NAME: 'browser-test-model',
              MODEL_API_KEY: modelKey,
              PREVIEW_AUTH_TOKEN: previewToken,
              MODEL_CHAT_COMPLETIONS_URL: 'http://127.0.0.1:9020/chat/completions',
            },
            reuseExistingServer: false,
          },
        ]
      : []),
    ...(!externalServices
      ? [
          {
            command: 'pnpm --filter @h5cs/ops-web start',
            url: `http://127.0.0.1:3002${opsBasePath}/login`,
            env: {
              ...common,
              NEXT_PUBLIC_OPS_BASE_PATH: opsBasePath,
              NODE_ENV: 'test',
              OPS_ADMIN_USERNAME: 'browser_test_operator',
              OPS_ADMIN_PASSWORD_HASH: `scrypt:${operatorSalt.toString('base64url')}:${scryptSync(operatorPassword, operatorSalt, 64).toString('base64url')}`,
              OPS_SESSION_SIGNING_KEY: randomBytes(32).toString('base64url'),
              OPS_PUBLIC_ORIGIN: opsOrigin,
              MANAGEMENT_CONSOLE_URL: `${merchantOrigin}${merchantBasePath}`,
            },
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ]
      : []),
    ...(!externalServices
      ? [
          {
            command: 'pnpm --filter @h5cs/merchant-web start',
            url: `http://127.0.0.1:3000${merchantBasePath}/setup`,
            env: {
              ...common,
              NEXT_PUBLIC_MERCHANT_BASE_PATH: merchantBasePath,
              NODE_ENV: 'test',
              MERCHANT_PUBLIC_ORIGIN: merchantOrigin,
              MERCHANT_PHONE_LOOKUP_KEY: randomBytes(32).toString('base64url'),
              CONSUMER_H5_ORIGIN: publicOrigin,
              PUBLIC_CONVERSATION_ENABLED: 'true',
              CONVERSATION_WORKER_ENABLED: 'true',
              MODEL_PROVIDER: 'chat_completions',
              MODEL_NAME: 'browser-test-model',
              PUBLISH_PROMPT_TEMPLATE_VERSION: 'browser-v1',
              PUBLISH_RETRIEVAL_POLICY_VERSION: 'browser-v1',
              PUBLISH_MODEL_POLICY_VERSION: 'browser-v1',
              API_READINESS_URL: 'http://127.0.0.1:4000/readyz',
              WORKER_READINESS_URL: 'http://127.0.0.1:3011/readyz',
              PREVIEW_AUTH_TOKEN: previewToken,
            },
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ]
      : []),
    ...(!externalServices
      ? [
          {
            command: 'pnpm --filter @h5cs/consumer-h5 exec next start --port 3003',
            url: 'http://127.0.0.1:3003/',
            env: {
              NODE_ENV: 'production',
              CONSUMER_H5_ORIGIN: publicOrigin,
              NEXT_PUBLIC_PUBLIC_API_BASE_URL: '/api/v1/public',
            },
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ]
      : []),
    {
      command: 'node tests/e2e/public-gateway.mjs',
      url: 'http://127.0.0.1:3001/_gateway-health',
      env: { H5CS_E2E_PATH_MODE: pathMode },
      reuseExistingServer: false,
    },
  ],
});
