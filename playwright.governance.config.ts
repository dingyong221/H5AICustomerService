import { defineConfig } from '@playwright/test';

const database = new URL(process.env['H5CS_INTEGRATION_MYSQL_URL'] ?? 'invalid:');
if (
  process.env['NODE_ENV'] !== 'test' ||
  process.env['APP_ENV'] !== 'test' ||
  database.protocol !== 'mysql:' ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  database.port !== '33188' ||
  database.pathname !== '/h5cs_integration_ci' ||
  !process.env['H5CS_GOV_FIXTURES']
)
  throw new Error('Governance browser tests require the isolated local integration runner');

export default defineConfig({
  testDir: './tests/governance',
  testMatch: '*.spec.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    browserName: 'chromium',
    launchOptions: {
      executablePath:
        process.env['H5CS_GOV_BROWSER_EXECUTABLE'] ??
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
    },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
