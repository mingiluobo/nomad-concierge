import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
// This file is outside the product suite and never creates an application fixture.
test('TOOLING-REPORT-001 保存自检附件并生成报告', async ({ request }, info) => {
  void request;
  expect(process.env.QA_REPORT_MODE).toBe('tooling-self-check');
  expect(process.env.QA_EXECUTION_AUTHORIZED).not.toBe('candidate');
  await info.attach('tooling-body.json', { body: JSON.stringify({ purpose: 'tooling-self-check', productCasesExecuted: 0 }), contentType: 'application/json' });
  const path = info.outputPath('tooling-file.txt');
  await writeFile(path, 'QA tooling attachment only; no product case executed.\n');
  await info.attach('tooling-file', { path, contentType: 'text/plain' });
});
