import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PathMapping { from: string; to: string }

/** Display-only normalization; callers retain live execution pointers separately. */
export function sanitizeText(text: string, mappings: readonly PathMapping[] = []): string {
  let result = text.replace(/file:\/\/(?=\/(?:Users|home|private|var\/folders|tmp)\/)/g, '');
  for (const { from, to } of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
    if (!from) throw new Error('An empty path mapping is not allowed');
    for (const source of new Set([from.replace(/\/$/, ''), encodeURI(from.replace(/\/$/, ''))])) {
      result = result.split(source).join(to.replace(/\/$/, ''));
    }
  }
  // A source checkout can be recognized without retaining its machine-specific parent.
  result = result.replace(/\/(?:Users|home)\/[^\s"'<>`()]+?\/qa(?=\/|["'<>`\s)]|$)/g, 'qa');
  result = result.replace(/\/(?:private\/)?var\/folders\/[^/\s]+\/[^/\s]+\/[TC]\//g, '临时目录/');
  result = result.replace(/\/(?:private\/)?(?:var\/)?tmp(?=\/|["'<>`\s)]|$)/g, '临时目录');
  result = result.replace(/\/(?:Users|home)\/[^/\s"'<>`]+/g, '用户目录');
  return result;
}

/** Recursively preserves values, IDs and conclusions, including path-valued object keys. */
export function sanitizeTree(value: unknown, mappings: readonly PathMapping[] = []): unknown {
  if (typeof value === 'string') return sanitizeText(value, mappings);
  if (Array.isArray(value)) return value.map(item => sanitizeTree(item, mappings));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = sanitizeText(key, mappings);
      if (Object.hasOwn(result, normalized)) throw new Error('Path normalization would merge distinct JSON keys');
      Object.defineProperty(result, normalized, { value: sanitizeTree(item, mappings), enumerable: true, configurable: true, writable: true });
    }
    return result;
  }
  return value;
}

async function main(args: string[]): Promise<void> {
  const mode = args.shift();
  if (mode !== '--check' && mode !== '--apply') throw new Error('Usage: sanitize-paths --check|--apply --repository-root ROOT [--map FROM=TO] FILE...');
  let root = '';
  const mappings: PathMapping[] = [];
  const files: string[] = [];
  while (args.length) {
    const arg = args.shift()!;
    if (arg === '--repository-root') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('Expected --repository-root ROOT');
      root = resolve(value);
    }
    else if (arg === '--map') {
      const entry = args.shift() ?? '';
      const separator = entry.indexOf('=');
      if (separator < 1) throw new Error('Expected --map FROM=TO');
      mappings.push({ from: entry.slice(0, separator), to: entry.slice(separator + 1) });
    } else files.push(arg);
  }
  if (!root || !files.length) throw new Error('An explicit repository root and at least one evidence file are required');
  mappings.push({ from: root, to: '.' });
  let changed = 0;
  for (const file of files) {
    const path = resolve(root, file);
    const name = relative(root, path);
    if (!name.startsWith('qa/') || !/\.(?:json|md|log|txt|html|xml|trace|network|stacks)$/.test(name)) throw new Error('Only explicit QA text artifacts may be normalized');
    if (/\/(?:prepared|candidate)\.json$/.test(name)) throw new Error('Live execution pointers must not be normalized');
    const before = await readFile(path, 'utf8');
    // Text replacement preserves original formatting in published evidence. JSON is
    // additionally traversed to reject key collisions before the result is written.
    if (name.endsWith('.json')) sanitizeTree(JSON.parse(before), mappings);
    const after = sanitizeText(before, mappings).replace(/(?<=["'(`\s])\.\/qa\//g, 'qa/');
    if (before !== after) {
      changed++;
      if (mode === '--apply') await writeFile(path, after);
      process.stdout.write(`${mode === '--apply' ? 'normalized' : 'needs normalization'} ${name}\n`);
    }
  }
  process.stdout.write(`files=${files.length} changed=${changed}\n`);
  if (mode === '--check' && changed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`${sanitizeText(String(error))}\n`); process.exitCode = 1; });
}
