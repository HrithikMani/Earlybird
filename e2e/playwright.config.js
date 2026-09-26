import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const live = process.env.EARLYBIRD_LIVE === '1';

export default defineConfig({
  testDir: path.join(here, 'specs'),
  outputDir: path.join(here, 'test-results'),
  globalSetup: path.join(here, 'support', 'global-setup.mjs'),
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  grep: live ? /@live/ : undefined,
  grepInvert: live ? undefined : /@live/,
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: path.join(here, 'report'), open: 'never' }]]
    : [['list'], ['html', { outputFolder: path.join(here, 'report'), open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
