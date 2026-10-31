import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const qaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(qaRoot, 'reports', 'preparation', 'node-environments.json');
const toolchains = join(qaRoot, 'reports', 'toolchains');
const checkedAt = new Date().toISOString();
const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
const defaultBefore = { node: process.version, executable: process.execPath };
const results = [];
await mkdir(dirname(output), { recursive: true });
await mkdir(toolchains, { recursive: true });

const versionOrder = (left, right) => {
  const a = left.replace(/^v/, '').split('.').map(Number);
  const b = right.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return b[index] - a[index];
  return 0;
};
const exists = async path => access(path).then(() => true, () => false);
const sha256 = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
async function command(executable, args) {
  const result = await run(executable, args, { timeout: 180_000, maxBuffer: 1024 * 1024 });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
async function inspect(root, requested, source, verification) {
  const nodePath = await realpath(join(root, 'bin', 'node'));
  const npmPath = await realpath(join(root, 'bin', 'npm'));
  const nodeResult = await command(nodePath, ['--version']);
  const npmResult = await command(nodePath, [npmPath, '--version']);
  if (requested === '22.13.0' && nodeResult.stdout !== 'v22.13.0') throw new Error(`Unexpected Node version: ${nodeResult.stdout}`);
  if (requested === '24' && !/^v24\./.test(nodeResult.stdout)) throw new Error(`Unexpected Node version: ${nodeResult.stdout}`);
  if (Number(npmResult.stdout.split('.')[0]) < 10) throw new Error(`Unsupported npm version: ${npmResult.stdout}`);
  return {
    requested, status: 'READY', source, nodeVersion: nodeResult.stdout, npmVersion: npmResult.stdout,
    root: await realpath(root), nodePath, npmPath, npmCommand: [nodePath, npmPath],
    architecture: (await command(nodePath, ['-p', 'process.platform + " " + process.arch'])).stdout,
    verification: verification ?? { method: 'executed-existing-toolchain', note: 'Existing installation reused; no global configuration changed.' },
    evidence: { node: nodeResult, npm: npmResult },
  };
}
async function prepare(requested) {
  if (process.platform !== 'darwin') throw new Error(`Expected macOS, observed ${process.platform}`);
  if (!['arm64', 'x64'].includes(process.arch)) throw new Error(`Unsupported architecture ${process.arch}`);
  const versions = await readdir(nvmRoot).catch(() => []);
  const matching = versions.filter(version => requested === '24' ? /^v24\.\d+\.\d+$/.test(version) : version === 'v22.13.0').sort(versionOrder);
  for (const version of matching) {
    const root = join(nvmRoot, version);
    if (await exists(join(root, 'bin', 'node'))) return inspect(root, requested, 'existing-nvm-installation');
  }
  if (requested !== '22.13.0') throw new Error('No Node 24 installation found; select a reviewed official Node 24 version before downloading.');
  const version = 'v22.13.0';
  const archiveName = `node-${version}-darwin-${process.arch}.tar.gz`;
  const archive = join(toolchains, archiveName);
  const checksums = join(toolchains, `${version}-SHASUMS256.txt`);
  const root = join(toolchains, archiveName.replace(/\.tar\.gz$/, ''));
  const baseURL = `https://nodejs.org/dist/${version}`;
  const checksumURL = `${baseURL}/SHASUMS256.txt`;
  const archiveURL = `${baseURL}/${archiveName}`;
  const transfer = [];
  for (const [url, destination] of [[checksumURL, checksums], [archiveURL, archive]]) {
    transfer.push({ url, destination, ...await command('/usr/bin/curl', ['--fail', '--location', '--show-error', '--silent', '--connect-timeout', '20', '--max-time', '150', '--output', destination, url]) });
  }
  const checksumText = await readFile(checksums, 'utf8');
  const expected = checksumText.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === archiveName)?.[0];
  if (!expected) throw new Error(`Official checksum missing for ${archiveName}`);
  const actual = await sha256(archive);
  if (actual !== expected) throw new Error(`SHA256 mismatch for ${archiveName}: expected ${expected}; received ${actual}`);
  await command('/usr/bin/tar', ['-xzf', archive, '-C', toolchains]);
  return inspect(root, requested, 'official-nodejs.org-distribution', { method: 'SHA256', checksumURL, archiveURL, expected, actual, matched: true, transfer });
}
for (const requested of ['22.13.0', '24']) {
  try { results.push(await prepare(requested)); }
  catch (error) {
    results.push({ requested, status: 'BLOCKED', error: { message: String(error.message ?? error), code: error.code ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } });
  }
}
const report = {
  phase: 'environment-preparation-only', checkedAt, host: { platform: process.platform, architecture: process.arch },
  defaultBefore, defaultAfter: { node: process.version, executable: process.execPath },
  defaultUnchanged: defaultBefore.node === process.version && defaultBefore.executable === process.execPath,
  productExecuted: false, dependencyLockModified: false, environments: results,
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output, environments: results.map(({ requested, status, nodeVersion, npmVersion, nodePath }) => ({ requested, status, nodeVersion, npmVersion, nodePath })), defaultUnchanged: report.defaultUnchanged }, null, 2)}\n`);
if (results.some(result => result.status === 'BLOCKED')) process.exitCode = 1;
