import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeLlmServer } from '../fakes/llm-server.js';
import { cleanEnv, command, poll } from './process.js';

export async function assertNoEnv(root: string): Promise<void> {
  // File names only. Never open an environment file.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    if (entry.name === '.env' || (entry.name.startsWith('.env.') && entry.name !== '.env.example')) throw new Error('Candidate contains a forbidden environment file');
    if (entry.isDirectory()) await assertNoEnv(join(root, entry.name));
  }
}
async function allocatePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Cannot allocate port');
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}

export class AppInstance {
  readonly fakeRemote = new FakeLlmServer();
  readonly fakeLocal = new FakeLlmServer();
  baseURL = '';
  env: NodeJS.ProcessEnv = {};
  directory = '';
  databasePath = '';
  private child?: ChildProcess;
  private processOutput = '';
  private exited?: Promise<void>;
  private history: { pid?: number; args: string[]; node: string; at: string }[] = [];
  get pid(): number | undefined { return this.child?.pid; }
  constructor(readonly root: string, readonly overrides: Record<string, string> = {}, readonly selfCheck?: { sourceCommit: string }) {}

  async initialize(): Promise<void> {
    if (this.selfCheck) {
      if (await command('git', ['rev-parse', 'HEAD'], this.root) !== this.selfCheck.sourceCommit) throw new Error('Tooling self-check snapshot mismatch');
    } else if (process.env.QA_EXECUTION_AUTHORIZED !== 'candidate') throw new Error('QA preparation only: a declared candidate is required before execution');
    await assertNoEnv(this.root);
    this.directory = await mkdtemp(join(tmpdir(), 'nc-qa-instance-'));
    this.databasePath = join(this.directory, 'qa.sqlite');
    await this.fakeRemote.start();
    await this.fakeLocal.start();
    const port = await allocatePort();
    this.baseURL = `http://127.0.0.1:${port}`;
    this.env = cleanEnv({
      NODE_ENV: 'production', SERVE_WEB_DIST: 'true', LLM_MODEL: 'qa-model',
      ...this.overrides,
      PORT: String(port), WEB_ORIGIN: this.overrides.WEB_ORIGIN ?? this.baseURL,
      DATABASE_PATH: this.databasePath,
      LLM_BASE_URL: this.fakeRemote.baseURL, LOCAL_LLM_BASE_URL: this.fakeLocal.baseURL,
    });
    await this.start();
  }
  async start(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) throw new Error('This instance is already running');
    // Start script is an allowed operating contract. Spawn node directly so signals reach the API process.
    const manifest = JSON.parse(await readFile(join(this.root, 'apps/api/package.json'), 'utf8')) as { scripts: { start: string } };
    const tokens = manifest.scripts.start.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map(token => token.replace(/^["']|["']$/g, '')) ?? [];
    const nodeIndex = tokens.indexOf('node');
    if (nodeIndex < 0 || tokens.some(token => /[;&|`$]/.test(token))) throw new Error('API start command needs a reviewed direct-node adapter');
    const prefix = tokens.slice(0, nodeIndex);
    for (const value of prefix) {
      const match = /^(NODE_ENV|SERVE_WEB_DIST)=(.+)$/.exec(value);
      if (!match) throw new Error('Unsupported API start command prefix');
    }
    await access(join(this.root, 'node_modules'));
    const child = spawn(process.execPath, tokens.slice(nodeIndex + 1), { cwd: join(this.root, 'apps/api'), env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.history.push({ pid: child.pid, args: tokens.slice(nodeIndex + 1), node: process.version, at: new Date().toISOString() });
    this.processOutput += `\nstart pid=${child.pid} command=node ${tokens.slice(nodeIndex + 1).join(' ')}\n`;
    child.stdout?.on('data', data => { this.processOutput += String(data); });
    child.stderr?.on('data', data => { this.processOutput += String(data); });
    this.exited = new Promise<void>(resolve => { child.once('close', (code, signal) => { this.processOutput += `\nexit code=${code} signal=${signal}\n`; resolve(); }); child.once('error', error => { this.processOutput += String(error); resolve(); }); });
    await poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned API exited before readiness: ${this.processOutput}`);
      const response = await fetch(`${this.baseURL}/api/health`, { signal: AbortSignal.timeout(700) });
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Owned API exited during readiness check');
      return response.status;
    }, status => status === 200, 15_000);
    if (process.platform === 'darwin') {
      const owned = await command('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), `-iTCP:${new URL(this.baseURL).port}`, '-sTCP:LISTEN', '-Fp'], this.root, undefined, cleanEnv(), 5000);
      if (!owned.split('\n').includes(`p${child.pid}`)) throw new Error('Readiness endpoint is not owned by this API process');
    }
  }
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill(signal);
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned API did not exit within 12 seconds')), 12_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async restart(): Promise<void> { await this.stop(); await this.start(); }
  async dispose(evidenceDirectory: string): Promise<void> {
    const errors: unknown[] = [];
    try { await this.stop(); } catch (error) { errors.push(error); try { await this.stop('SIGKILL'); } catch (killError) { errors.push(killError); } }
    try {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, 'api-process.log'), this.processOutput);
      await writeFile(join(evidenceDirectory, 'fake-requests.json'), JSON.stringify({ remote: this.fakeRemote.requests, local: this.fakeLocal.requests }, null, 2));
      const config = Object.fromEntries(Object.entries(this.env).filter(([name]) => /^(PORT|DATABASE_PATH|WEB_ORIGIN|SERVE_WEB_DIST|DEMO_|TURN_|LLM_|LOCAL_LLM_|BREAKER_|LIMIT_|TOKENS_)/.test(name) && name !== 'LLM_API_KEY'));
      await writeFile(join(evidenceDirectory, 'instance.json'), JSON.stringify({ baseURL: this.baseURL, processes: this.history, config, purpose: this.selfCheck ? 'tooling-self-check' : 'candidate-acceptance', sourceCommit: this.selfCheck?.sourceCommit, candidate: this.selfCheck ? null : process.env.QA_CANDIDATE_COMMIT }, null, 2));
    } catch (error) { errors.push(error); }
    const cleanup = await Promise.allSettled([this.fakeRemote.close(), this.fakeLocal.close(), ...(this.directory ? [rm(this.directory, { recursive: true, force: true })] : [])]);
    for (const result of cleanup) if (result.status === 'rejected') errors.push(result.reason);
    if (errors.length) throw new AggregateError(errors, 'QA instance cleanup/evidence failed');
  }
}
