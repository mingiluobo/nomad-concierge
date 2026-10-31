import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { command } from './process.js';
import { assertNoEnv } from './app.js';

export interface Candidate {
  candidateCommit: string; productCommit: string; qaCommit: string;
  wp6Ready: boolean; declaredReadyBy: string;
  specVersion: string; readmeSha256: string; lockSha256: string;
}
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export async function candidate(root: string, path: string): Promise<Candidate> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Candidate;
  for (const name of ['candidateCommit', 'productCommit', 'qaCommit'] as const) {
    if (!/^[a-f0-9]{40}$/.test(value[name] ?? '')) throw new Error(`Candidate manifest requires a full ${name}`);
    await command('git', ['cat-file', '-e', `${value[name]}^{commit}`], root);
  }
  if (!value.wp6Ready || !value.declaredReadyBy?.trim()) throw new Error('Candidate must be declared ready by the integration owner');
  for (const revision of [value.productCommit, value.qaCommit]) await command('git', ['merge-base', '--is-ancestor', revision, value.candidateCommit], root);
  const readme = await command('git', ['show', `${value.candidateCommit}:README.md`], root);
  const lock = await command('git', ['show', `${value.candidateCommit}:package-lock.json`], root);
  // command trims stdout; file hashes below are authoritative after checkout.
  if (!readme || !lock) throw new Error('Candidate lacks operating documents or lockfile');
  return value;
}
export async function verifySnapshot(root: string, info: Candidate): Promise<void> {
  if (await command('git', ['rev-parse', 'HEAD'], root) !== info.candidateCommit) throw new Error('Candidate SHA mismatch');
  if (sha256(await readFile(join(root, 'README.md'))) !== info.readmeSha256) throw new Error('README differs from declared candidate');
  if (sha256(await readFile(join(root, 'package-lock.json'))) !== info.lockSha256) throw new Error('Lockfile differs from declared candidate');
  const spec = await readFile(join(root, 'docs/SPEC.md'), 'utf8');
  if (!spec.includes(`版本：${info.specVersion}`)) throw new Error('SPEC version differs from declared candidate');
  const dirty = await command('git', ['status', '--porcelain', '--untracked-files=no'], root);
  if (dirty) throw new Error('Candidate has tracked modifications');
  await assertNoEnv(root);
}
export async function freshClone(source: string, commit: string, target: string, log: string): Promise<void> {
  await command('git', ['clone', '--no-hardlinks', '--no-checkout', source, target], source, log);
  await command('git', ['checkout', '--detach', commit], target, log);
  await assertNoEnv(target);
}
export async function saveMetadata(directory: string, info: Candidate, root: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'metadata.json'), JSON.stringify({ ...info, node: process.version, platform: process.platform, arch: process.arch, builtWith: 'npm run build', startedAt: new Date().toISOString(), root, specSha256: sha256(await readFile(join(root, 'docs/SPEC.md'))) }, null, 2));
}
