/* eslint-disable no-empty-pattern -- Playwright requires object destructuring for unused fixture arguments. */
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodeEnvironment, linuxEnvironment, dockerEnvironment } from '../../harness/environment.js';
import { command } from '../../harness/process.js';
import { manualResults } from '../../harness/manual.js';

test('ENV-001 macOS Node 22.13.0 全新克隆', async ({ browser }, info) => { await nodeEnvironment('22', info.outputPath('environment'), browser); });
test('ENV-002 macOS Node 24 全新克隆', async ({ browser }, info) => { await nodeEnvironment('24', info.outputPath('environment'), browser); });
test('ENV-003 干净 Linux Node 安装无需编译工具', async ({}, info) => { await linuxEnvironment(info.outputPath('environment')); });
test('ENV-004 Docker README 路径和数据持久化', async ({ browser }, info) => { await dockerEnvironment(info.outputPath('environment'), browser); });
test('ENV-005 提交文件及交付包卫生', async ({}, info) => {
  const root = process.env.QA_BUILD_ROOT;
  if (!root) throw new Error('BLOCKED: declared candidate required');
  const files = (await command('git', ['ls-files'], root)).split('\n');
  const forbidden = /(^|\/)(node_modules|dist|\.venv|vendor|\.DS_Store)(\/|$)|(^|\/)\.env(?:$|\.(?!example$))|\.(?:db|sqlite)(?:-(?:wal|shm))?$/;
  expect(files.filter(path => forbidden.test(path))).toEqual([]);
  const clues: { path: string; line: number }[] = [];
  // git grep is restricted to token-shaped matches and emits only locations, never values.
  const scan = "const{execFileSync}=require('node:child_process');let s='';try{s=execFileSync('git',['grep','-n','-I','-E','sk-[A-Za-z0-9_-]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----','HEAD'],{encoding:'utf8'})}catch(e){if(e.status!==1)throw e;}console.log(JSON.stringify(s.split('\\n').filter(Boolean).map(x=>{const m=/^HEAD:(.*?):(\\d+):/.exec(x);return m?{path:m[1],line:Number(m[2])}:null}).filter(Boolean)))";
  clues.push(...JSON.parse(await command(process.execPath, ['-e', scan], root)));
  await info.attach('secret-clues-locations-only', { body: JSON.stringify(clues, null, 2), contentType: 'application/json' });
  if (clues.length) {
    const review = (await manualResults(process.env.QA_CANDIDATE_COMMIT ?? '')).find(row => row.id === 'MAN-005' && row.result === '通过');
    if (!review || clues.some(clue => !review.reviewedClues?.some(approved => approved.path === clue.path && approved.line === clue.line))) throw new Error('BLOCKED: token-shaped content needs MAN-005 review; no values were disclosed');
  }
  const archive = process.env.QA_SUBMISSION_ARCHIVE;
  if (!archive) throw new Error('BLOCKED: final submission archive has not been provided');
  const listing = await command('tar', ['-tf', archive], root);
  expect(listing.split('\n').filter(path => forbidden.test(path))).toEqual([]);
  await writeFile(info.outputPath('submission-files.txt'), listing);
  expect(await readFile(join(root, 'qa/reports/summary.md'), 'utf8')).not.toBe('');
});
