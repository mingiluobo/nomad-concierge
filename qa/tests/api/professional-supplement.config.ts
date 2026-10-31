import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const runDirectory = process.env.QA_RUN_DIR;
if (!runDirectory) throw new Error('Supplemental inspection requires a separate QA_RUN_DIR');
export default defineConfig({
  testDir: '.', testMatch: 'professional-supplement.check.ts',
  fullyParallel: false, workers: 1, retries: 0, maxFailures: 0,
  timeout: 90_000, expect: { timeout: 12_000 },
  outputDir: resolve(runDirectory, 'round-1', 'artifacts'),
  reporter: [
    ['list'],
    ['json', { outputFile: resolve(runDirectory, 'round-1', 'results.json') }],
    ['html', { outputFolder: resolve(runDirectory, 'round-1', 'html'), open: 'never' }],
  ],
  use: { trace: 'on' },
});
