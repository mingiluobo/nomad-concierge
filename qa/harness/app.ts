import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
async function allocatePort(excluded: ReadonlySet<number>): Promise<number> {
  for (let allocation = 0; allocation < 10; allocation++) {
    const socket = createServer();
    // Match the API's default wildcard binding, including IPv6 where available.
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, resolve); });
    const address = socket.address();
    await new Promise<void>(resolve => socket.close(() => resolve()));
    if (!address || typeof address === 'string') throw new Error('Cannot allocate port');
    if (!excluded.has(address.port)) return address.port;
  }
  throw new Error('Cannot allocate a different initial port');
}

class InitialPortConflict extends Error {}

function isListenConflict(output: string, port: number): boolean {
  return /\bcode:\s*['"]EADDRINUSE['"]/.test(output)
    && /\bsyscall:\s*['"]listen['"]/.test(output)
    && new RegExp(`\\bport:\\s*${port}(?=\\s|[,}])`).test(output)
    && new RegExp(`\\blisten EADDRINUSE:[^\\r\\n]*:${port}(?=\\s|$)`).test(output);
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
  private localResourcesPath?: string;
  private history: { pid?: number; port: number; args: string[]; node: string; at: string; exitCode?: number | null; signal?: NodeJS.Signals | null }[] = [];
  get pid(): number | undefined { return this.child?.pid; }
  constructor(readonly root: string, readonly overrides: Record<string, string> = {}, readonly selfCheck?: { sourceCommit: string }) {}

  private get localMode(): boolean {
    return !this.selfCheck && process.env.QA_EXECUTION_AUTHORIZED === 'local' && process.env.QA_REPORT_MODE === 'local';
  }
  private async saveLocalResources(): Promise<void> {
    if (!this.localResourcesPath) return;
    const temporary = `${this.localResourcesPath}.tmp`;
    await writeFile(temporary, JSON.stringify({
      directory: this.directory,
      processes: this.history,
      pids: this.history.flatMap(entry => entry.pid === undefined ? [] : [entry.pid]),
      purpose: 'local-e2e',
      sourceCommit: process.env.QA_SOURCE_COMMIT ?? null,
    }, null, 2));
    await rename(temporary, this.localResourcesPath);
  }
  async initialize(): Promise<void> {
    if (this.selfCheck) {
      if (await command('git', ['rev-parse', 'HEAD'], this.root) !== this.selfCheck.sourceCommit) throw new Error('Tooling self-check snapshot mismatch');
    } else if (process.env.QA_EXECUTION_AUTHORIZED !== 'candidate' && !this.localMode) throw new Error('QA preparation only: a declared candidate or explicit local mode is required before execution');
    await assertNoEnv(this.root);
    const localResourcesRoot = this.localMode ? process.env.QA_LOCAL_RESOURCES_ROOT : undefined;
    if (this.localMode && !localResourcesRoot) throw new Error('Local execution requires QA_LOCAL_RESOURCES_ROOT');
    if (localResourcesRoot) await mkdir(localResourcesRoot, { recursive: true });
    this.directory = await mkdtemp(join(tmpdir(), 'nc-qa-instance-'));
    if (localResourcesRoot) {
      this.localResourcesPath = join(localResourcesRoot, `${basename(this.directory)}.json`);
      await this.saveLocalResources();
    }
    this.databasePath = join(this.directory, 'qa.sqlite');
    await this.fakeRemote.start();
    await this.fakeLocal.start();
    const triedPorts = new Set<number>();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const port = await allocatePort(triedPorts);
      triedPorts.add(port);
      this.baseURL = `http://127.0.0.1:${port}`;
      this.env = cleanEnv({
        NODE_ENV: 'production', SERVE_WEB_DIST: 'true', LLM_MODEL: 'qa-model',
        ...this.overrides,
        PORT: String(port), WEB_ORIGIN: this.overrides.WEB_ORIGIN ?? this.baseURL,
        DATABASE_PATH: this.databasePath,
        LLM_BASE_URL: this.fakeRemote.baseURL, LOCAL_LLM_BASE_URL: this.fakeLocal.baseURL,
      });
      try { await this.start(); return; }
      catch (error) {
        if (!(error instanceof InitialPortConflict)) throw error;
        this.processOutput += `\ninitial port conflict attempt=${attempt}/3 pid=${this.pid} port=${port}; ${attempt < 3 ? 'retrying with a new port' : 'attempt limit reached'}\n`;
        if (attempt === 3) throw error;
      }
    }
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
    const port = Number(this.env.PORT);
    const entry: (typeof this.history)[number] = { pid: child.pid, port, args: tokens.slice(nodeIndex + 1), node: process.version, at: new Date().toISOString() };
    this.history.push(entry);
    this.processOutput += `\nstart pid=${child.pid} port=${port} command=node ${tokens.slice(nodeIndex + 1).join(' ')}\n`;
    let output = '';
    let spawnError: Error | undefined;
    const capture = (data: unknown) => { output += String(data); this.processOutput += String(data); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', error => { spawnError = error; capture(error); });
    this.exited = new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        entry.exitCode = code;
        entry.signal = signal;
        this.processOutput += `\nexit pid=${child.pid} port=${port} code=${code} signal=${signal}\n`;
        resolve();
      });
    });
    if (this.localResourcesPath) await this.saveLocalResources();
    const exited = () => spawnError !== undefined || child.exitCode !== null || child.signalCode !== null;
    // Return terminal outcomes instead of throwing inside poll: terminal errors must not be retried for 15 seconds.
    const outcome = await poll(async () => {
      if (exited()) return 'exited' as const;
      const response = await fetch(`${this.baseURL}/api/health`, { signal: AbortSignal.timeout(700) });
      if (exited()) return 'exited' as const;
      if (response.status !== 200) return 'pending' as const;
      if (process.platform === 'darwin') {
        const owned = await command('/usr/sbin/lsof', ['-nP', '-a', '-p', String(child.pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], this.root, undefined, cleanEnv(), 5000);
        if (!owned.split('\n').includes(`p${child.pid}`)) throw new Error('Readiness endpoint is not owned by this API process');
      }
      return exited() ? 'exited' as const : 'ready' as const;
    }, status => status !== 'pending', 15_000);
    if (outcome === 'exited') {
      // close follows exit and drains stdout/stderr; classify only this attempt's complete output.
      await this.exited;
      const failure = `Owned API exited before readiness: pid=${child.pid} port=${port} code=${child.exitCode} signal=${child.signalCode}\n${output}`;
      if (!spawnError && child.exitCode !== null && child.exitCode !== 0 && isListenConflict(output, port)) throw new InitialPortConflict(failure);
      throw new Error(failure, { cause: spawnError });
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
      const purpose = this.selfCheck ? 'tooling-self-check' : this.localMode ? 'local-e2e'
        : process.env.QA_REPORT_MODE === 'stability-prerun' ? 'stability-prerun' : 'candidate-acceptance';
      await writeFile(join(evidenceDirectory, 'instance.json'), JSON.stringify({
        baseURL: this.baseURL, processes: this.history, config, purpose,
        ...(purpose === 'stability-prerun' ? { label: '预跑，不计入放行', countsTowardRelease: false } : {}),
        ...(purpose === 'local-e2e' ? { label: '本地运行，不计入正式放行', countsTowardRelease: false } : {}),
        sourceCommit: this.selfCheck?.sourceCommit ?? (this.localMode ? process.env.QA_SOURCE_COMMIT ?? null : undefined),
        candidate: this.selfCheck || this.localMode ? null : process.env.QA_CANDIDATE_COMMIT,
      }, null, 2));
    } catch (error) { errors.push(error); }
    const cleanup = await Promise.allSettled([this.fakeRemote.close(), this.fakeLocal.close(), ...(this.directory ? [rm(this.directory, { recursive: true, force: true })] : [])]);
    for (const result of cleanup) if (result.status === 'rejected') errors.push(result.reason);
    if (errors.length) throw new AggregateError(errors, 'QA instance cleanup/evidence failed');
  }
}
