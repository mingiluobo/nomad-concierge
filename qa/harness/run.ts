import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { candidate, freshClone, saveMetadata, verifySnapshot, type Candidate } from './candidate.js';
import { cleanEnv, command } from './process.js';
import { writeSummary } from './summary.js';

const qaRoot = resolve(process.cwd());
const source = resolve(qaRoot, '..');
const reportRoot = join(qaRoot, 'reports');
const mode = process.argv[2] ?? 'full';
interface Prepared { runId: string; directory: string; root: string; info: Candidate; marker: string }
async function prepare(): Promise<void> {
  let alreadyPrepared = false;
  try { await access(join(reportRoot, 'prepared.json')); alreadyPrepared = true; } catch { /* No candidate prepared yet. */ }
  if (alreadyPrepared) throw new Error('An owned candidate is already prepared; execute or explicitly clean it before preparing another');
  const manifestPath = resolve(process.env.QA_CANDIDATE_MANIFEST ?? join(qaRoot, 'candidate.json'));
  const info = await candidate(source, manifestPath);
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const runDirectory = join(reportRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'nc-qa-candidate-'));
  const root = join(directory, 'candidate');
  const marker = randomUUID();
  try {
    await writeFile(join(directory, '.owned-by-nc-qa'), marker);
    await freshClone(source, info.candidateCommit, root, join(runDirectory, 'prepare.log'));
    if (info.reviewedQaCommit) await command('git', ['restore', '--source', info.reviewedQaCommit, '--staged', '--worktree', '--', 'qa/'], root, join(runDirectory, 'prepare.log'));
    await verifySnapshot(root, info);
    await command('npm', ['ci'], root, join(runDirectory, 'prepare.log'));
    await command('npm', ['run', 'compile', '--workspace', 'qa'], root, join(runDirectory, 'prepare.log'));
    await command('npx', ['--no-install', 'playwright', 'install', 'chromium'], root, join(runDirectory, 'prepare.log'));
    await saveMetadata(runDirectory, info, root);
    await writeFile(join(reportRoot, 'prepared.json'), JSON.stringify({ runId, directory, root, info, marker } satisfies Prepared, null, 2));
    process.stdout.write(`Candidate dependencies prepared at ${root}. Product acceptance has not run.\n`);
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
async function execute(): Promise<void> {
  const prepared = JSON.parse(await readFile(join(reportRoot, 'prepared.json'), 'utf8')) as Prepared;
  if (!basename(prepared.directory).startsWith('nc-qa-candidate-') || await readFile(join(prepared.directory, '.owned-by-nc-qa'), 'utf8') !== prepared.marker || prepared.root !== join(prepared.directory, 'candidate')) throw new Error('Invalid owned candidate directory');
  await verifySnapshot(prepared.root, prepared.info);
  const runDirectory = join(reportRoot, prepared.runId);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^QA_(NODE22_BIN|NODE24_BIN|ENV_RECIPE|LINUX_NPM_CACHE|DOCKER_BUILDER|DOCKER_BASE_CONTEXT|SUBMISSION_ARCHIVE|MANUAL_RESULTS|DEFECT_REVIEW)$/.test(key) && value));
  const env = cleanEnv({ ...environment, QA_READ_OVERFLOW_POLICY: 'clamp', QA_EXECUTION_AUTHORIZED: 'candidate', QA_BUILD_ROOT: prepared.root, QA_CANDIDATE_COMMIT: prepared.info.candidateCommit, QA_RUN_DIR: runDirectory, QA_REPORT_ROOT: reportRoot, npm_config_offline: 'true' });
  let failures = 0;
  let operationalError: string | undefined;
  try {
    await command('npm', ['run', 'build'], prepared.root, join(runDirectory, 'build.log'), env);
    const business = mode === 'full' || mode === 'business';
    const projects = business ? ['api', 'ws', 'e2e'] : [mode];
    const rounds = business ? 3 : 1;
    for (let round = 1; round <= rounds; round++) {
      try { await command('npx', ['--no-install', 'playwright', 'test', ...projects.map(project => `--project=${project}`)], join(prepared.root, 'qa'), join(runDirectory, `round-${round}.log`), { ...env, QA_ROUND: String(round) }, 3_600_000); }
      catch (error) { failures++; operationalError = `${operationalError ?? ''}\nround-${round}: ${String(error)}`; }
    }
    if (mode === 'full') {
      try { await command('npx', ['--no-install', 'playwright', 'test', '--project=env'], join(prepared.root, 'qa'), join(runDirectory, 'environment.log'), { ...env, QA_ROUND: 'environment' }, 3_600_000); }
      catch (error) { failures++; operationalError = `${operationalError ?? ''}\nenvironment: ${String(error)}`; }
    }
  } catch (error) { failures++; operationalError = String(error); }
  finally {
    try { const ready = await writeSummary(reportRoot, runDirectory, prepared.info, mode, operationalError); if (mode === 'full' && !ready) failures++; }
    finally {
      try { await rm(prepared.directory, { recursive: true, force: true }); }
      finally { await rm(join(reportRoot, 'prepared.json'), { force: true }); }
    }
  }
  if (failures) process.exitCode = 1;
}
try { if (mode === 'prepare') await prepare(); else if (['full', 'business', 'api', 'ws', 'e2e', 'env'].includes(mode)) await execute(); else throw new Error('Unknown QA run mode'); }
catch (error) { process.stderr.write(`QA blocked before acceptance: ${String(error)}\n`); process.exitCode = 1; }
