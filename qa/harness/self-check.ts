import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppInstance, assertNoEnv } from './app.js';
import { freshClone, sha256, type Candidate } from './candidate.js';
import { cleanEnv, command } from './process.js';
import { FakeLlmServer } from '../fakes/llm-server.js';
import { writeSummary } from './summary.js';

interface Observation { step: string; status: 'checked' | 'blocked'; detail: unknown }
const qaRoot = resolve(process.cwd());
const source = resolve(qaRoot, '..');
const sourceCommit = await command('git', ['rev-parse', 'main'], source);
const qaCommit = await command('git', ['rev-parse', 'HEAD'], source);
const runId = `tooling-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const evidence = join(qaRoot, 'reports/preparation', runId);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'nc-qa-tooling-'));
const root = join(directory, 'main-snapshot');
const observations: Observation[] = [];
const env = cleanEnv({ PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` });
let app: AppInstance | undefined;
async function inspect(step: string, action: () => Promise<unknown>): Promise<boolean> {
  try { const detail = await action(); observations.push({ step, status: 'checked', detail }); process.stdout.write(`${step}: checked (tooling only)\n`); return true; }
  catch (error) { observations.push({ step, status: 'blocked', detail: String(error) }); process.stdout.write(`${step}: blocked; observation only\n`); return false; }
}
try {
  await inspect('fake-services', async () => {
    const fake = new FakeLlmServer();
    try {
      await fake.start();
      const value = { intent: 'provide_info', updates: [], unsure: [] };
      fake.setBehavior({ kind: 'json', value });
      const response = await fetch(`${fake.baseURL}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer qa-fake-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qa-model', messages: [] }) });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse((await response.json() as { choices: { message: { content: string } }[] }).choices[0].message.content), value);
      fake.setModels(['self-check-model']);
      assert.deepEqual(await (await fetch(`${fake.baseURL}/models`)).json(), { data: [{ id: 'self-check-model' }] });
      fake.setBehavior({ kind: 'raw', content: 'controlled-invalid-json' });
      assert.match(await (await fetch(`${fake.baseURL}/chat/completions`, { method: 'POST' })).text(), /controlled-invalid-json/);
      fake.setBehavior({ kind: 'http', status: 500 });
      assert.equal((await fetch(`${fake.baseURL}/chat/completions`, { method: 'POST' })).status, 500);
      assert.equal(fake.requests.length, 4);
      await writeFile(join(evidence, 'fake-self-check.json'), JSON.stringify(fake.requests, null, 2));
      return { requests: fake.requests.length, endpoint: fake.baseURL, behaviors: ['json', 'models', 'raw', 'http500'] };
    } finally { await fake.close(); }
  });
  const built = await inspect('independent-main-build', async () => {
    await freshClone(source, sourceCommit, root, join(evidence, 'prepare.log'));
    await assertNoEnv(root);
    await command('npm', ['ci'], root, join(evidence, 'prepare.log'), env);
    await command('npm', ['run', 'build'], root, join(evidence, 'build.log'), env);
    return { sourceCommit, root, environmentFiles: 'none', productTestsExecuted: 0 };
  });
  if (built) {
    await inspect('start-port-database-restarts', async () => {
      app = new AppInstance(root, {}, { sourceCommit });
      await app.initialize();
      assert.equal(app.env.LLM_API_KEY, '');
      assert.equal(app.env.LOCAL_LLM_MODEL, '');
      const firstPid = app.pid;
      const port = Number(new URL(app.baseURL).port);
      assert.ok(port > 0 && port !== 3001);
      const before = await stat(app.databasePath);
      const header = (await readFile(app.databasePath)).subarray(0, 16).toString();
      assert.equal(header, 'SQLite format 3\0');
      await app.restart();
      const secondPid = app.pid;
      assert.notEqual(secondPid, firstPid);
      assert.throws(() => process.kill(firstPid!, 0));
      assert.equal((await stat(app.databasePath)).ino, before.ino);
      await app.stop('SIGKILL');
      assert.throws(() => process.kill(secondPid!, 0));
      await app.start();
      assert.notEqual(app.pid, secondPid);
      const response = await fetch(`${app.baseURL}/api/health`);
      assert.equal(response.status, 200);
      return { baseURL: app.baseURL, pids: [firstPid, secondPid, app.pid], databasePath: app.databasePath, sqliteHeader: 'verified', databasePreservedAcrossRestart: true, endpointsAccessed: ['/api/health'] };
    });
  }
  await inspect('report-generation', async () => {
    const runDirectory = join(evidence, 'report-preview/run');
    const reportRoot = join(evidence, 'report-preview');
    await mkdir(runDirectory, { recursive: true });
    await command('npx', ['--no-install', 'playwright', 'test', '--config=self-check/playwright.config.ts'], qaRoot, join(evidence, 'reporter.log'), { ...env, QA_REPORT_MODE: 'tooling-self-check', QA_RUN_DIR: runDirectory, QA_ROUND: 'tooling', QA_REPORT_ROOT: reportRoot });
    await access(join(runDirectory, 'html/index.html'));
    const generated = JSON.parse(await readFile(join(runDirectory, 'round-tooling/results.json'), 'utf8')) as { purpose: string; rows: { id: string; evidence: string[] }[] };
    assert.equal(generated.purpose, 'tooling-self-check');
    assert.equal(generated.rows.length, 1);
    assert.ok(generated.rows[0].id.startsWith('TOOLING-REPORT'));
    assert.equal(generated.rows[0].evidence.length, 2);
    for (const path of generated.rows[0].evidence) await access(path);
    const info: Candidate = { candidateCommit: '', productCommit: sourceCommit, qaCommit, wp6Ready: false, declaredReadyBy: '', specVersion: 'v1.3', readmeSha256: sha256(await readFile(join(root, 'README.md'))), lockSha256: sha256(await readFile(join(root, 'package-lock.json'))) };
    assert.equal(await writeSummary(reportRoot, runDirectory, info, 'tooling-self-check'), false);
    const summary = await readFile(join(reportRoot, 'summary.md'), 'utf8');
    assert.ok(summary.includes('正式候选未交接，产品用例未执行'));
    assert.ok(summary.includes('| API-014 | 未执行 |'));
    assert.ok(summary.includes('| MAN-007 | 不适用 |'));
    return { html: join(runDirectory, 'html/index.html'), json: join(runDirectory, 'round-tooling/results.json'), markdown: join(reportRoot, 'summary.md'), productCasesExecuted: 0, releaseGranted: false };
  });
} finally {
  await inspect('owned-resource-cleanup', async () => {
    try { if (app) await app.dispose(join(evidence, 'instance')); }
    finally { await rm(directory, { recursive: true, force: true }); }
    await assert.rejects(access(directory));
    if (app?.directory) await assert.rejects(access(app.directory));
    if (app?.pid) assert.throws(() => process.kill(app!.pid!, 0));
    return 'Only this run’s clone, database and processes were removed; evidence retained.';
  });
  await writeFile(join(evidence, 'self-check.json'), JSON.stringify({ purpose: 'tooling-self-check', createdAt: new Date().toISOString(), sourceCommit, qaCommit, node: process.version, productCasesExecuted: 0, productDefectsReported: 0, observations }, null, 2));
  await writeFile(join(qaRoot, 'reports/preparation/latest-self-check.json'), JSON.stringify({ evidence, sourceCommit, observations }, null, 2));
}
if (observations.some(row => row.status === 'blocked')) process.exitCode = 1;
process.stdout.write(`Tooling evidence: ${evidence}\nProduct acceptance remains unexecuted.\n`);
