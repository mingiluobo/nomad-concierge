import process from 'node:process';
import console from 'node:console';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLocalArtifacts } from './local-artifacts.mjs';

const label = '本地运行，不计入正式放行';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const directory = join(repositoryRoot, 'qa/reports/local', runId);
const relativeDirectory = relative(repositoryRoot, directory).split(sep).join('/');
const expectedIds = Array.from({ length: 6 }, (_, index) => `E2E-00${index + 1}`);
const started = Date.now();
const steps = [];
let temporary, executionRoot, active, interrupted;
let outcome = '失败', failure, results;
const cleanup = { instanceDirectories: 0, processIds: [], survivingProcessIds: [], snapshotRemoved: false };
const safeEnvironment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
const environment = { ...safeEnvironment, CI: '1', npm_config_offline: 'true', LLM_API_KEY: '', LOCAL_LLM_MODEL: '', LLM_BASE_URL: 'http://127.0.0.1:1', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1' };
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, env: environment, encoding: 'utf8' }).stdout?.trim() || null;
const gitStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repositoryRoot, env: environment, encoding: 'utf8' });
const sourceDirty = gitStatus.status === 0 ? Boolean(gitStatus.stdout.trim()) : null;
const relativePath = value => relative(repositoryRoot, value).split(sep).join('/');

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function interrupt(signal) {
  interrupted = signal;
  outcome = '失败';
  signalGroup(active, signal);
}
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function command(name, executable, args, cwd, env = environment) {
  if (interrupted) throw new Error(`Interrupted: ${interrupted}`);
  const at = Date.now();
  const stream = createWriteStream(join(directory, `${name}.log`));
  const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  active = child;
  const capture = data => { stream.write(data); process.stdout.write(data); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  try {
    const result = await new Promise((fulfill, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => fulfill({ code, signal }));
    });
    steps.push({ name, command: [executable === process.execPath ? 'node' : executable, ...args.map(arg => isAbsolute(arg) ? relative(cwd, arg).split(sep).join('/') : arg)], startedAt: new Date(at).toISOString(), durationMs: Date.now() - at, ...result, log: relativePath(join(directory, `${name}.log`)) });
    if (result.code !== 0 || interrupted) throw new Error(`${name} failed (${result.signal ?? result.code})`);
  } finally {
    // Let Playwright finish browser teardown before cleaning its owned app process group.
    signalGroup(child, 'SIGKILL');
    active = undefined;
    await new Promise(fulfill => stream.end(fulfill));
  }
}

async function includeSource(path) {
  const parts = relative(repositoryRoot, path).split(sep);
  const name = basename(path);
  // Reject environment files by NAME, before opening or following anything.
  if (name === '.env' || name.startsWith('.env.') || name === '.git') return false;
  const dependency = parts.includes('node_modules');
  if (!dependency && (parts[0] === 'qa' && parts[1] === 'reports'
    || ['dist', 'coverage', 'playwright-report', 'test-results'].includes(name)
    || /\.(?:log|tsbuildinfo|sqlite|db)(?:-shm|-wal)?$/.test(name))) return false;
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    const destination = relative(repositoryRoot, resolve(dirname(path), target));
    if (isAbsolute(target) || destination === '..' || destination.startsWith(`..${sep}`)) {
      throw new Error(`External source/dependency symlink is unsupported: ${parts.join('/')}`);
    }
  }
  return true;
}

async function cleanupResources() {
  const registry = join(directory, '.runtime');
  try {
    for (const name of await readdir(registry).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const item = JSON.parse(await readFile(join(registry, name), 'utf8'));
      if (item.purpose !== 'local-e2e' || dirname(item.directory) !== tmpdir() || !/^nc-qa-instance-[\w-]+$/.test(basename(item.directory)) || name !== `${basename(item.directory)}.json`) throw new Error('Invalid local resource ownership record');
      for (const pid of item.pids) {
        cleanup.processIds.push(pid);
        try { process.kill(pid, 0); cleanup.survivingProcessIds.push(pid); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (cleanup.survivingProcessIds.length) throw new Error('An owned app process is still alive after process-group cleanup');
      await rm(item.directory, { recursive: true, force: true });
      cleanup.instanceDirectories++;
    }
  } finally {
    await rm(registry, { recursive: true, force: true });
    if (temporary) {
      await rm(temporary, { recursive: true, force: true });
      cleanup.snapshotRemoved = true;
    }
  }
}

await mkdir(directory, { recursive: true });
console.log(`\n${label}\n运行目录：${relativeDirectory}\n`);
try {
  await access(join(repositoryRoot, 'node_modules/@playwright/test/cli.js'));
  temporary = await mkdtemp(join(tmpdir(), 'nc-qa-local-'));
  executionRoot = join(temporary, 'source');
  const copiedAt = Date.now();
  // Copy dependency bytes and relative workspace links together; never link back to source dist.
  await cp(repositoryRoot, executionRoot, { recursive: true, dereference: false, verbatimSymlinks: true, filter: includeSource });
  steps.push({ name: 'snapshot', durationMs: Date.now() - copiedAt, environmentFiles: 'excluded by filename without reading', includesWorkingTreeChanges: true });
  await command('build', 'npm', ['run', 'build'], executionRoot);
  await command('compile', 'npm', ['run', 'compile', '--workspace', 'qa'], executionRoot);
  await command('browser', process.execPath, [join(executionRoot, 'node_modules/@playwright/test/cli.js'), 'test', '--config=local.playwright.config.ts'], join(executionRoot, 'qa'), {
    ...environment, QA_EXECUTION_AUTHORIZED: 'local', QA_REPORT_MODE: 'local', QA_BUILD_ROOT: executionRoot,
    QA_RUN_DIR: directory, QA_REPORT_ROOT: directory, QA_ROUND: 'local', QA_LOCAL_RESOURCES_ROOT: join(directory, '.runtime'),
    ...(sourceCommit ? { QA_SOURCE_COMMIT: sourceCommit } : {}), QA_READ_OVERFLOW_POLICY: 'clamp',
  });
  results = JSON.parse(await readFile(join(directory, 'round-local/results.json'), 'utf8'));
  if (results.rows.length !== 6 || JSON.stringify(results.rows.map(row => row.id).sort()) !== JSON.stringify(expectedIds)
    || results.rows.some(row => row.result !== '通过') || results.status !== 'passed') throw new Error('All six core browser scenarios must pass; absent, skipped or blocked cases are not success');
  outcome = '通过';
} catch (error) {
  failure = String(error.stack ?? error);
  console.error(error.message);
  console.error('前提：先在仓库根目录执行 npm ci 和 npx playwright install chromium。');
}
{
  try { await cleanupResources(); }
  catch (error) { outcome = '失败'; failure = `${failure ?? ''}\nCleanup: ${error.stack ?? error}`; }
  const metadata = {
    purpose: 'local-e2e', label, countsTowardRelease: false, candidate: null, sourceCommit,
    sourceKind: 'working-tree-copy', sourceDirty, includesWorkingTreeChanges: true,
    node: process.version, platform: process.platform, architecture: process.arch,
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
    outcome, interrupted: interrupted ?? null, expectedIds, steps, cleanup, failure: failure ?? null,
    report: `${relativeDirectory}/round-local/html/index.html`,
  };
  await writeFile(join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2));
  await writeFile(join(directory, 'summary.md'), `# ${label}\n\n结果：${outcome}。范围：E2E-001～006；正式候选：无。\n\n当前工作树副本（包含未提交改动）；来源提交：${sourceCommit ?? '无 Git 提交信息'}。\n\n耗时：${(metadata.durationMs / 1000).toFixed(2)} 秒；Node ${process.version}。\n\n- 逐例结果：${relativeDirectory}/round-local/results.json\n- HTML：${metadata.report}\n- 录屏：${relativeDirectory}/videos/\n- 执行轨迹及附件：${relativeDirectory}/round-local/artifacts/\n- 执行与清理记录：${relativeDirectory}/metadata.json\n\n本次运行不更新正式报告、候选声明、追踪矩阵或放行轮次。\n`);
  try {
    const audit = await normalizeLocalArtifacts({ directory, repositoryRoot, executionRoot: executionRoot ?? repositoryRoot });
    await writeFile(join(directory, 'path-audit.json'), JSON.stringify(audit, null, 2));
    if (audit.unresolvedMachinePaths.length) throw new Error('Local evidence still contains machine paths');
  } catch (error) {
    outcome = '失败';
    metadata.outcome = outcome;
    metadata.artifactNormalizationFailed = true;
    await writeFile(join(directory, 'metadata.json'), JSON.stringify({ ...metadata, failure: 'Evidence normalization failed; see console output' }, null, 2));
    await writeFile(join(directory, 'summary.md'), `# ${label}\n\n结果：失败。证据路径规范化未完成，请查看本次日志。\n`);
    console.error(`证据路径规范化失败：${error.message}`);
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  console.log(`\n${label}：${outcome}；耗时 ${((Date.now() - started) / 1000).toFixed(2)} 秒。\n报告：${relativeDirectory}/summary.md`);
  process.exitCode = interrupted ? 130 : outcome === '通过' ? 0 : 1;
}
