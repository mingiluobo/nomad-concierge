import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, request, type Browser } from '@playwright/test';
import { freshClone, sha256 } from './candidate.js';
import { cleanEnv, command, poll } from './process.js';
import { ApiClient } from './api.js';
import { WorkspacePage } from '../fixtures/pages.js';
import { TID } from '../../packages/shared/src/testids.js';

interface Step { command: string; args: string[]; readmeText: string }
interface Recipe {
  readmeSha256: string;
  node: { install: Step; check: Step; test: Step; build: Step; start: Step; initialize?: Step; port: number };
  docker: { up: Step; service: string; port: number };
}
export async function recipeFor(root: string): Promise<Recipe> {
  if (!process.env.QA_ENV_RECIPE) throw new Error('BLOCKED: final README operating recipe has not been transcribed');
  const recipe = JSON.parse(await readFile(process.env.QA_ENV_RECIPE, 'utf8')) as Recipe;
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  if (sha256(readme) !== recipe.readmeSha256) throw new Error('BLOCKED: recipe belongs to another README revision');
  for (const step of [recipe.node.install, recipe.node.check, recipe.node.test, recipe.node.build, recipe.node.start, recipe.node.initialize, recipe.docker.up].filter(Boolean) as Step[]) {
    if (!step.command || !step.readmeText || !readme.includes(step.readmeText)) throw new Error('BLOCKED: every environment command must quote the final README');
    if (step.command !== 'npm' && step.command !== 'docker' && step.command !== 'node') throw new Error('BLOCKED: unsupported README command requires an adapter');
    if (!step.readmeText.includes([step.command, ...step.args].join(' '))) throw new Error('BLOCKED: command differs from quoted README');
    if (step.args.some(arg => arg.includes('test:e2e') || arg === 'qa')) throw new Error('Environment subprocess must not recursively invoke QA');
  }
  return recipe;
}
export async function requireFreePort(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', () => reject(new Error(`BLOCKED: port ${port} is occupied; no existing process was stopped`))); server.listen(port, resolve); });
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function cloneForEnvironment(label: string, evidence: string): Promise<{ directory: string; root: string }> {
  if (process.env.QA_EXECUTION_AUTHORIZED !== 'candidate' || !process.env.QA_BUILD_ROOT || !process.env.QA_CANDIDATE_COMMIT) throw new Error('BLOCKED: a declared candidate is required');
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), `nc-qa-${label}-`));
  const root = join(directory, 'candidate');
  try { await freshClone(process.env.QA_BUILD_ROOT, process.env.QA_CANDIDATE_COMMIT, root, join(evidence, 'commands.log')); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { directory, root };
}
/** Same public workflow for every environment; exercises a real persistent database. */
export async function smoke(baseURL: string) {
  const context = await request.newContext({ baseURL });
  try {
    const api = new ApiClient(context);
    await api.login('qa-environment');
    const created = await api.create('我想搬到葡萄牙生活，我是中国籍，一个人，没有孩子。');
    await api.settle(created.conversation.id);
    await api.send(created.conversation.id, '', [
      { slot: 'currentResidence', value: 'CN', label: '中国' },
      { slot: 'residenceStatus', value: 'citizen', label: '公民' },
      { slot: 'timeline', value: '6to12m', label: '明年' },
      { slot: 'incomeSource', value: 'freelancer', label: '自由职业' },
    ]);
    const detail = await api.settle(created.conversation.id);
    expect(detail.conversation.progress.isComplete).toBe(true);
    const { plan } = await api.plan(created.conversation.id);
    expect(plan.content.profileSummary.known).toEqual(expect.arrayContaining([expect.objectContaining({ slot: 'applicantNationality' })]));
    expect(plan.content.disclaimer).toContain('持牌');
    expect(plan.content.phases.flatMap(phase => phase.steps).length).toBeGreaterThan(0);
    return { conversation: created.conversation.id, plan };
  } finally { await context.dispose(); }
}
async function waitHealth(baseURL: string) { await poll(async () => (await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(700) })).status, value => value === 200, 30_000); }
async function browserSmoke(browser: Browser, baseURL: string, evidence: string): Promise<void> {
  const context = await browser.newContext({ baseURL, recordVideo: { dir: join(evidence, 'videos') } });
  await context.route('**/*', route => new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort('blockedbyclient'));
  await context.routeWebSocket(/.*/, socket => new URL(socket.url()).host === new URL(baseURL).host ? socket.connectToServer() : socket.close({ code: 1008 }));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  try {
    const ui = new WorkspacePage(page);
    await ui.login(`qa-env-ui-${Date.now()}`);
    const id = await ui.send('我是中国人，想搬到葡萄牙生活。');
    await ui.settled(id);
    await expect(page.getByTestId(TID.profileSlot('applicantNationality'))).toContainText('中国');
    await ui.send('不对，我是葡萄牙籍。');
    await ui.settled(id);
    await expect(page.getByTestId(TID.profileSlot('applicantNationality'))).toContainText('葡萄牙');
    await page.getByTestId(TID.generateEarly).click();
    await page.getByTestId(TID.generateConfirm).click();
    await expect.poll(async () => (await ui.detail(id)).plan?.id).toBeTruthy();
    const planId = (await ui.detail(id)).plan!.id;
    await page.goto(`/plans/${planId}`);
    await ui.live();
    await expect(page.getByTestId(TID.planFirstStep)).not.toBeEmpty();
    await expect(page.getByTestId(TID.planDisclaimer)).toContainText('不能替代持牌');
    await page.screenshot({ path: join(evidence, 'browser-plan.png'), fullPage: true });
  } finally {
    try { await context.tracing.stop({ path: join(evidence, 'browser.trace.zip') }); }
    finally { await context.close(); }
  }
}
async function stopOwned(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Detached process group belongs exclusively to this environment check.
  const signal = (value: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  try { await poll(async () => child.exitCode !== null || child.signalCode !== null, Boolean, 12_000); }
  catch { signal('SIGKILL'); await poll(async () => child.exitCode !== null || child.signalCode !== null, Boolean, 5000); }
}
export async function nodeEnvironment(kind: '22' | '24', evidence: string, browser: Browser): Promise<void> {
  const node = process.env[`QA_NODE${kind}_BIN`];
  if (!node) throw new Error(`BLOCKED: QA_NODE${kind}_BIN is not supplied`);
  await access(node);
  const { directory, root } = await cloneForEnvironment(`node${kind}`, evidence);
  let child: ChildProcess | undefined;
  try {
    const recipe = await recipeFor(root);
    const version = await command(node, ['--version'], root, join(evidence, 'commands.log'));
    expect(kind === '22' ? version === 'v22.13.0' : /^v24\./.test(version)).toBe(true);
    expect(process.platform).toBe('darwin');
    await requireFreePort(recipe.node.port);
    const env = cleanEnv({ PATH: `${dirname(node)}${delimiter}${process.env.PATH}`, npm_config_offline: 'true', PORT: String(recipe.node.port) });
    expect(await command('node', ['--version'], root, join(evidence, 'commands.log'), env)).toBe(version);
    for (const step of [recipe.node.install, recipe.node.initialize, recipe.node.check, recipe.node.test, recipe.node.build].filter(Boolean) as Step[]) await command(step.command, step.args, root, join(evidence, 'commands.log'), env);
    const start = recipe.node.start;
    child = spawn(start.command, start.args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', data => { output += String(data); }); child.stderr?.on('data', data => { output += String(data); });
    try { await waitHealth(`http://localhost:${recipe.node.port}`); await smoke(`http://localhost:${recipe.node.port}`); await browserSmoke(browser, `http://localhost:${recipe.node.port}`, evidence); }
    finally { await stopOwned(child); await writeFile(join(evidence, 'server.log'), output); }
  } finally { try { await stopOwned(child); } finally { await rm(directory, { recursive: true, force: true }); } }
}
export async function dockerEnvironment(evidence: string, browser: Browser): Promise<void> {
  const { directory, root } = await cloneForEnvironment('docker', evidence);
  const project = `ncqa-${Date.now()}-${process.pid}`;
  const log = join(evidence, 'commands.log');
  const env = cleanEnv({ COMPOSE_PROJECT_NAME: project });
  let created = false;
  try {
    const recipe = await recipeFor(root);
    expect(recipe.docker.port).toBe(3001);
    await requireFreePort(3001);
    await command('docker', ['info'], root, log, env);
    // Images and caches must already exist; external network belongs to preparation.
    await command('docker', ['image', 'inspect', 'node:24-bookworm-slim'], root, log, env);
    const config = JSON.parse(await command('docker', ['compose', 'config', '--format', 'json'], root, undefined, env)) as { services: Record<string, { build?: unknown }>; networks?: Record<string, unknown> };
    const override = {
      services: Object.fromEntries(Object.entries(config.services).map(([name, service]) => [name, { ...(service.build ? { build: { network: 'none', pull: false } } : {}), pull_policy: 'never', environment: { LLM_API_KEY: '', LOCAL_LLM_MODEL: '', LLM_BASE_URL: 'http://127.0.0.1:1/v1', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1/v1' } }])),
      networks: Object.fromEntries(Object.keys(config.networks ?? { default: {} }).map(name => [name, { internal: true }])),
    };
    const overridePath = join(directory, 'qa-network-override.json');
    await writeFile(overridePath, JSON.stringify(override));
    // Preserve the README command; the override only restricts network/credential isolation.
    const composeCandidates = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
    let composeFile: string | undefined;
    for (const filename of composeCandidates) { try { await access(join(root, filename)); composeFile = join(root, filename); break; } catch { /* Try next supported compose name. */ } }
    if (!composeFile) throw new Error('BLOCKED: README compose file cannot be located');
    env.COMPOSE_FILE = `${composeFile}${delimiter}${overridePath}`;
    env.npm_config_offline = 'true';
    const step = recipe.docker.up;
    const child = spawn(step.command, step.args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    created = true;
    let output = '';
    child.stdout?.on('data', data => { output += String(data); }); child.stderr?.on('data', data => { output += String(data); });
    try {
      await waitHealth('http://localhost:3001');
      const saved = await smoke('http://localhost:3001');
      await browserSmoke(browser, 'http://localhost:3001', evidence);
      await command('docker', ['compose', 'restart', recipe.docker.service], root, log, env);
      await waitHealth('http://localhost:3001');
      const context = await request.newContext({ baseURL: 'http://localhost:3001' });
      try { const api = new ApiClient(context); await api.login('qa-environment'); const response = await context.get(`/api/plans/${saved.plan.id}`); expect(response.status()).toBe(200); expect((await response.json()).plan).toEqual(saved.plan); }
      finally { await context.dispose(); }
    } finally {
      await command('docker', ['compose', 'logs', '--no-color'], root, log, env).catch(() => undefined);
      await command('docker', ['compose', 'down', '--volumes', '--remove-orphans'], root, log, env);
      created = false;
      if (child.exitCode === null) child.kill('SIGTERM');
      await writeFile(join(evidence, 'compose.log'), output);
    }
  } finally {
    try { if (created) await command('docker', ['compose', 'down', '--volumes', '--remove-orphans'], root, log, env); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
export async function linuxEnvironment(evidence: string): Promise<void> {
  const { directory, root } = await cloneForEnvironment('linux', evidence);
  const container = `ncqa-linux-${Date.now()}-${process.pid}`;
  const log = join(evidence, 'commands.log');
  let created = false;
  try {
    const recipe = await recipeFor(root);
    const cache = process.env.QA_LINUX_NPM_CACHE;
    if (!cache) throw new Error('BLOCKED: prepared Linux npm cache is required for offline installation');
    await command('docker', ['image', 'inspect', 'node:24-bookworm-slim'], root, log);
    await command('docker', ['run', '--pull=never', '--network=none', '-d', '--name', container, '-v', `${root}:/work`, '-v', `${resolve(cache)}:/root/.npm`, '-w', '/work', '-e', 'LLM_API_KEY=', '-e', 'LOCAL_LLM_MODEL=', '-e', 'LLM_BASE_URL=http://127.0.0.1:1/v1', '-e', 'LOCAL_LLM_BASE_URL=http://127.0.0.1:1/v1', '-e', 'npm_config_offline=true', 'node:24-bookworm-slim', 'node', '-e', 'setInterval(() => {}, 2147483647)'], root, log);
    created = true;
    await command('docker', ['exec', container, 'node', '-e', "const f=require('node:fs');for(const p of ['/usr/bin/make','/usr/bin/g++','/usr/bin/gcc','/usr/bin/python3'])if(f.existsSync(p))throw Error(p);console.log(process.version)"], root, log);
    for (const step of [recipe.node.install, recipe.node.initialize, recipe.node.check, recipe.node.test, recipe.node.build].filter(Boolean) as Step[]) await command('docker', ['exec', container, step.command, ...step.args], root, log);
    await command('docker', ['exec', '-d', container, recipe.node.start.command, ...recipe.node.start.args], root, log);
    await poll(async () => { try { await command('docker', ['exec', container, 'node', '-e', `fetch('http://localhost:${recipe.node.port}/api/health').then(r=>{if(r.status!==200)process.exit(1)})`], root); return true; } catch { return false; } }, Boolean, 30_000);
    // Run the same public flow inside the container, without browser/system packages.
    await command('docker', ['exec', container, 'npm', 'run', 'compile', '--workspace', 'qa'], root, log);
    await command('docker', ['exec', '-w', '/work/qa', container, 'node', '--input-type=module', '-e', `import { smoke } from './dist/qa/harness/environment.js'; await smoke('http://localhost:${recipe.node.port}');`], root, log);
    await writeFile(join(evidence, 'browser-libraries.md'), 'Linux Node installation excludes browser execution. Chromium system libraries are a separate prerequisite for browser runs.\n');
  } finally {
    try { if (created) await command('docker', ['rm', '-f', container], root, log); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}
