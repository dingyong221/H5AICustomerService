import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/marketplace',
  testMatch: '*.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 240000,
  expect: { timeout: 30000 },
  reporter: 'line',
  use: {
    browserName: 'chromium',
    launchOptions: process.env['H5CS_A6_BROWSER_EXECUTABLE']
      ? { executablePath: process.env['H5CS_A6_BROWSER_EXECUTABLE'] }
      : {},
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
