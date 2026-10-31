import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runDirectory = process.env.QA_RUN_DIR ?? resolve(fileURLToPath(new URL('.', import.meta.url)), 'reports', 'unexecuted');
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 12_000 },
  outputDir: resolve(runDirectory, `round-${process.env.QA_ROUND ?? '1'}`, 'artifacts'),
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(runDirectory, `round-${process.env.QA_ROUND ?? '1'}`, 'html'), open: 'never' }],
    ['./harness/reporter.ts'],
  ],
  use: { channel: 'chromium', viewport: { width: 1440, height: 1000 }, trace: 'on', screenshot: 'only-on-failure', video: 'on', actionTimeout: 12_000 },
  // Owned-process fixtures replace webServer. No existing service can be reused.
  projects: [
    { name: 'api', testMatch: '**/api/**/*.spec.ts' },
    { name: 'ws', testMatch: '**/ws/**/*.spec.ts' },
    { name: 'e2e', testMatch: '**/e2e/**/*.spec.ts' },
    { name: 'env', testMatch: '**/env/**/*.spec.ts', timeout: 600_000 },
  ],
});
