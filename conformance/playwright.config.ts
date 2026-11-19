import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'scenarios',
  globalSetup: './setup.ts',
  outputDir: 'stardust-results/output',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'stardust-results/report' }],
  ],
  use: {
    ignoreHTTPSErrors: true,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
