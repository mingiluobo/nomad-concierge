import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppInstance } from '../harness/app.js';
import { command } from '../harness/process.js';

interface Attempt { port: number; origin: string | undefined; pid?: number }
interface Blocker { server: Server; port: number }
interface Scenario {
  name: string;
  blockedAttempts: number[];
  expectedAttempts: number;
  ordinaryExitAt?: number;
  mismatchedPort?: boolean;
  unhealthy?: boolean;
  origin?: string;
  restart?: boolean;
}
interface Observation { name: string; status: 'passed' | 'failed'; elapsedMs: number; attempts: Attempt[]; failure?: string; blockersRetained: number }

const qaRoot = resolve(process.cwd());
assert.ok(process.argv[2], 'Provide an evidence directory explicitly');
assert.equal(process.versions.node.split('.')[0], '24', 'Run the self-check with Node 24');
assert.equal(process.platform, 'darwin', 'This check includes macOS PID ownership verification');
const destination = resolve(process.argv[2]);
await mkdir(destination, { recursive: true });
const evidence = await mkdtemp(join(destination, 'run-'));
const fixtureRoot = join(evidence, 'fake-root');
await mkdir(join(fixtureRoot, 'apps', 'api'), { recursive: true });
await mkdir(join(fixtureRoot, 'node_modules'));
await writeFile(join(fixtureRoot, 'apps', 'api', 'package.json'), JSON.stringify({ type: 'module', scripts: { start: 'node fake-api.mjs' } }));
await copyFile(join(qaRoot, 'self-check', 'port-fake-api.mjs'), join(fixtureRoot, 'apps', 'api', 'fake-api.mjs'));
const sourceCommit = await command('git', ['rev-parse', 'HEAD'], qaRoot);
const observations: Observation[] = [];

async function block(port: number): Promise<Blocker> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ owner: 'qa-blocker', pid: process.pid }));
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(port, accept); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}
function assertExited(pid: number | undefined): void {
  assert.ok(pid, 'Fake process must have a PID');
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH', `PID ${pid} must have exited`);
}
class ControlledInstance extends AppInstance {
  readonly attempts: Attempt[] = [];
  readonly blockers: Blocker[] = [];
  constructor(readonly scenario: Scenario) {
    super(fixtureRoot, scenario.origin ? { WEB_ORIGIN: scenario.origin } : {}, { sourceCommit });
  }
  override async start(): Promise<void> {
    if (this.attempts.length) assertExited(this.attempts.at(-1)!.pid);
    const number = this.attempts.length + 1;
    const port = Number(this.env.PORT);
    const attempt: Attempt = { port, origin: this.env.WEB_ORIGIN };
    this.attempts.push(attempt);
    if (this.scenario.blockedAttempts.includes(number)) this.blockers.push(await block(port));
    if (this.scenario.mismatchedPort) {
      this.blockers.push(await block(port));
      const blocker = await block(0);
      assert.notEqual(blocker.port, port, 'Mismatched-port fixture needs a separate port');
      this.blockers.push(blocker);
      this.env.QA_PORT_CHECK_BIND_PORT = String(blocker.port);
    }
    this.env.QA_PORT_CHECK_MODE = this.scenario.ordinaryExitAt === number ? 'ordinary-exit' : this.scenario.unhealthy ? 'unhealthy' : 'ready';
    try { await super.start(); }
    finally { attempt.pid = this.pid; }
  }
}

const scenarios: Scenario[] = [
  { name: 'collision-then-ready', blockedAttempts: [1], expectedAttempts: 2 },
  { name: 'three-collisions-stop', blockedAttempts: [1, 2, 3], expectedAttempts: 3 },
  { name: 'collision-then-ordinary-exit', blockedAttempts: [1], ordinaryExitAt: 2, expectedAttempts: 2 },
  { name: 'restart-collision-keeps-port', blockedAttempts: [2], expectedAttempts: 2, restart: true },
  { name: 'different-port-error-not-retried', blockedAttempts: [], expectedAttempts: 1, mismatchedPort: true },
  { name: 'ordinary-exit-not-retried', blockedAttempts: [], expectedAttempts: 1, ordinaryExitAt: 1 },
  { name: 'health-timeout-not-retried', blockedAttempts: [], expectedAttempts: 1, unhealthy: true },
  { name: 'explicit-origin-retained', blockedAttempts: [1], expectedAttempts: 2, origin: 'https://qa-explicit-origin.invalid' },
];

try {
  for (const scenario of scenarios) {
    const app = new ControlledInstance(scenario);
    const started = performance.now();
    let testFailure: unknown;
    let expectedFailure = '';
    let blockersRetained = 0;
    const caseDirectory = join(evidence, scenario.name);
    try {
      if (scenario.restart) {
        await app.initialize();
        const original = { port: app.env.PORT, baseURL: app.baseURL, pid: app.pid };
        await assert.rejects(app.restart(), (error: unknown) => {
          expectedFailure = String(error);
          return expectedFailure.includes('EADDRINUSE');
        });
        assert.equal(app.env.PORT, original.port);
        assert.equal(app.baseURL, original.baseURL);
        assertExited(original.pid);
      } else if (scenario.blockedAttempts.length === 3 || scenario.ordinaryExitAt || scenario.mismatchedPort || scenario.unhealthy) {
        await assert.rejects(app.initialize(), (error: unknown) => {
          expectedFailure = String(error);
          if (scenario.ordinaryExitAt) return expectedFailure.includes('configuration rejected');
          if (scenario.unhealthy) return expectedFailure.includes('Condition not reached');
          return expectedFailure.includes('EADDRINUSE');
        });
      } else {
        await app.initialize();
        const response = await fetch(`${app.baseURL}/api/health`);
        assert.equal(response.status, 200);
        const body = await response.json() as { owner: string; pid: number; port: number; origin: string };
        assert.equal(body.owner, 'qa-fake-child', 'A healthy blocker must not masquerade as the child');
        assert.equal(body.pid, app.pid);
        assert.equal(body.port, Number(app.env.PORT));
        assert.equal(body.origin, scenario.origin ?? app.baseURL);
      }
      assert.equal(app.attempts.length, scenario.expectedAttempts);
      if (!scenario.restart) assert.equal(new Set(app.attempts.map(item => item.port)).size, app.attempts.length);
      else assert.equal(new Set(app.attempts.map(item => item.port)).size, 1);
      for (const attempt of app.attempts) assert.equal(attempt.origin, scenario.origin ?? `http://127.0.0.1:${attempt.port}`);
      if (!scenario.unhealthy) assert.ok(performance.now() - started < 10_000, 'Terminal child exits must not wait for the 15-second readiness timeout');
    } catch (error) { testFailure = error; }
    finally {
      try {
        await app.dispose(caseDirectory);
        for (const attempt of app.attempts) assertExited(attempt.pid);
        for (const blocker of app.blockers) {
          assert.equal(blocker.server.listening, true, 'App cleanup must not stop an independent blocker');
          const response = await fetch(`http://127.0.0.1:${blocker.port}/api/health`);
          assert.equal((await response.json() as { owner: string }).owner, 'qa-blocker');
          blockersRetained++;
        }
        const saved = JSON.parse(await readFile(join(caseDirectory, 'instance.json'), 'utf8')) as { processes: { pid: number; port: number; exitCode: number | null }[]; purpose: string };
        assert.equal(saved.purpose, 'tooling-self-check');
        assert.equal(saved.processes.length, app.attempts.length);
        assert.deepEqual(saved.processes.map(item => ({ pid: item.pid, port: item.port })), app.attempts.map(item => ({ pid: item.pid, port: item.port })));
        for (const process of saved.processes) assert.notEqual(process.exitCode, undefined);
        const log = await readFile(join(caseDirectory, 'api-process.log'), 'utf8');
        for (const attempt of app.attempts) assert.ok(log.includes(`pid=${attempt.pid} port=${attempt.port}`));
        if (scenario.blockedAttempts.length === 3) assert.match(log, /attempt limit reached/);
        if (scenario.ordinaryExitAt === 2) {
          assert.match(log, /EADDRINUSE/);
          assert.match(log, /configuration rejected/);
          assert.equal((log.match(/retrying with a new port/g) ?? []).length, 1);
        }
      } catch (error) { testFailure ??= error; }
      finally {
        await Promise.all(app.blockers.map(async blocker => {
          blocker.server.closeAllConnections();
          await new Promise<void>((accept, reject) => blocker.server.close(error => error ? reject(error) : accept()));
        }));
      }
    }
    const observation: Observation = { name: scenario.name, status: testFailure ? 'failed' : 'passed', elapsedMs: Math.round(performance.now() - started), attempts: app.attempts, failure: testFailure ? String(testFailure) : expectedFailure || undefined, blockersRetained };
    observations.push(observation);
    process.stdout.write(`${scenario.name}: ${observation.status}; attempts=${app.attempts.length}; ${observation.elapsedMs} ms\n`);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ purpose: 'pure-qa-harness-self-check', productCasesExecuted: 0, countsTowardRelease: false, sourceCommit, node: process.version, createdAt: new Date().toISOString(), observations }, null, 2));
}
process.stdout.write(`Evidence: ${evidence}\n`);
if (observations.some(observation => observation.status === 'failed')) process.exitCode = 1;
