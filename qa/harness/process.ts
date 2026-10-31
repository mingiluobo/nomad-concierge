import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Only an explicit allowlist is inherited; model credentials and NODE_OPTIONS never leak in. */
export function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, CI: '1', LLM_API_KEY: '', LOCAL_LLM_MODEL: '', LLM_BASE_URL: 'http://127.0.0.1:1/v1', LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1/v1', ...extra };
}
export async function command(commandName: string, args: string[], cwd: string, log?: string, env = cleanEnv(), timeout = 600_000): Promise<string> {
  if (log) await mkdir(dirname(log), { recursive: true });
  return await new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } } }, timeout);
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', async code => {
      clearTimeout(timer);
      try {
        if (log) await appendFile(log, `$ ${commandName} ${args.join(' ')}\n${output}\nexit=${code}\n`);
        if (code !== 0) reject(new Error(`${commandName} exited ${code}; ${log ? `see ${log}` : output.slice(-1800)}`));
        else resolve(output.trim());
      } catch (error) { reject(error); }
    });
  });
}
export async function poll<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accepts(value)) return value; last = value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Condition not reached in ${timeout} ms: ${String(last)}`);
}
