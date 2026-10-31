import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from './playwright.config.js';

if (process.env.QA_EXECUTION_AUTHORIZED !== 'local' || process.env.QA_REPORT_MODE !== 'local' || !process.env.QA_RUN_DIR) {
  throw new Error('Use npm run test:e2e from the repository root for owned local execution');
}
const label = '本地运行，不计入正式放行';
export default defineConfig(base, {
  metadata: { purpose: 'local-e2e', label, countsTowardRelease: false },
  grep: /\bE2E-00[1-6]\b/,
  projects: [{ name: 'e2e', testMatch: '**/e2e/journeys.spec.ts' }],
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(process.env.QA_RUN_DIR, 'round-local/html'), open: 'never', title: label }],
    ['./harness/reporter.ts'],
  ],
});
