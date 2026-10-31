import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const output = process.env.QA_RUN_DIR ?? resolve(fileURLToPath(new URL('.', import.meta.url)), '../reports/preparation/report-self-check');
export default defineConfig({
  testDir: '.', testMatch: 'reporter.spec.ts', workers: 1, retries: 0,
  outputDir: resolve(output, 'tooling-artifacts'),
  reporter: [['list'], ['html', { outputFolder: resolve(output, 'html'), open: 'never' }], ['../harness/reporter.ts']],
});
