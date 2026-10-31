import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
// Public package export in the lockfile's playwright-core 1.64.1; no extra package.
import { yauzl, yazl } from 'playwright-core/lib/utilsBundle';

const hash = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const slash = value => value.split(sep).join('/');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const binary = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.webm', '.mp4', '.pdf', '.woff', '.woff2', '.ttf', '.wasm']);
const source = label => /\/src@/.test(label) || /\.(?:[cm]?[jt]sx?)$/.test(label);
const zipMagic = data => data.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(data.readUInt32LE(0));
const dataUri = /data:([\w.+/-]+);base64,([A-Za-z0-9+/=\r\n]+)/g;
const systemRoots = [
  ['/root/.npm', '容器缓存目录/npm'], ['/root/.cache', '容器缓存目录'], ['/root', '容器用户目录'],
  ['/usr/local', '系统工具目录/local'], ['/usr', '系统工具目录'], ['/bin', '系统工具目录/bin'], ['/sbin', '系统工具目录/sbin'],
  ['/opt/homebrew', '系统工具目录/homebrew'], ['/var/lib/docker', '容器数据目录/docker'], ['/var/run', '系统运行目录'],
  ['/run', '系统运行目录'], ['/etc', '系统配置目录'], ['/dev', '系统设备目录'], ['/sys', '系统状态目录'], ['/proc', '系统状态目录/proc'],
  ['/System/Library', '系统资源目录'], ['/Library', '系统资源目录'], ['/Applications', '系统应用目录'],
];
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function readZip(data) {
  return new Promise((fulfill, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, archive) => {
      if (error) { reject(error); return; }
      const entries = [];
      const fail = reason => { archive.close(); reject(reason); };
      archive.on('error', fail);
      archive.on('entry', entry => {
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError) { fail(streamError); return; }
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', fail);
          stream.on('end', () => {
            const body = Buffer.concat(chunks);
            if (crc32(body) !== entry.crc32) { fail(new Error('ZIP CRC mismatch')); return; }
            entries.push({ entry, body });
            archive.readEntry();
          });
        });
      });
      archive.on('end', () => fulfill({ entries, comment: archive.comment }));
      archive.readEntry();
    });
  });
}

async function writeZip(entries, comment = '') {
  const archive = new yazl.ZipFile();
  const complete = new Promise((fulfill, reject) => {
    const chunks = [];
    archive.on('error', reject);
    archive.outputStream.on('data', chunk => chunks.push(chunk));
    archive.outputStream.on('error', reject);
    archive.outputStream.on('end', () => fulfill(Buffer.concat(chunks)));
  });
  for (const { name, body, entry, comment: fileComment } of entries) {
    const options = { mtime: entry?.getLastModDate() ?? new Date('2000-01-01T00:00:00Z'), fileComment: fileComment ?? '' };
    const mode = entry?.externalFileAttributes >>> 16;
    if (mode) options.mode = mode;
    if (name.endsWith('/')) archive.addEmptyDirectory(name, options);
    else archive.addBuffer(body, name, { ...options, compress: entry?.compressionMethod !== 0 });
  }
  archive.end({ comment: Buffer.from(comment) });
  return complete;
}

class Normalizer {
  constructor(repositoryRoot, executionRoot) {
    const repo = slash(resolve(repositoryRoot));
    const execution = slash(resolve(executionRoot));
    this.mappings = [[repo + '/', ''], [repo, '仓库根目录']];
    if (execution !== repo) this.mappings.push([execution + '/qa/', 'qa/'], [execution, `临时目录/${basename(dirname(execution))}/${basename(execution)}`]);
    for (const [old, replacement] of [...this.mappings]) {
      if (/^\/(?:var|tmp)\//.test(old)) this.mappings.push(['/private' + old, replacement]);
      if (/^\/private\/(?:var|tmp)\//.test(old)) this.mappings.push([old.slice(8), replacement]);
    }
    for (const [old, replacement] of [...this.mappings]) this.mappings.push([encodeURI(old), replacement]);
    this.mappings.sort((a, b) => b[0].length - a[0].length);
    this.audit = { purpose: 'local-artifact-path-normalization', productTestsExecuted: false, checkedFiles: 0, changedFiles: [], zipArchivesValidated: 0, embeddedZipArchivesValidated: 0, jsonDocumentsValidated: 0, jsonlDocumentsValidated: 0, binaryPayloadsPreserved: 0, sourceResourceLinksRemapped: 0, unresolvedMachinePaths: [] };
  }

  plain(value, isSource = false) {
    let text = value.replace(/file:\/\/(?=\/(?:Users|home|private|var|tmp)\/)/g, '');
    for (const [old, replacement] of this.mappings) {
      const boundary = old.endsWith('/') ? '' : '(?=/|[\\s"\'<>`):,]|$)';
      if (!isSource && text.includes('../')) text = text.replace(new RegExp('(?<![\\w./])(?:\\.\\./)+' + escape(old.replace(/^\//, '')) + boundary, 'g'), () => replacement);
      text = text.replace(new RegExp(escape(old) + boundary, 'g'), () => replacement);
    }
    if (!isSource) text = text.replace(/(?<![\w./])(?:\.\.\/)*\.\.qa\//g, 'qa/');
    text = text.replace(/\/(?:private\/)?var\/folders\/[^/\s"<>]+\/[^/\s"<>]+\/[TC]\//g, '临时目录/');
    text = text.replace(/(?<![\p{L}\p{N}_:])\/(?:private\/)?(?:var\/)?tmp(?=\/|[\s"'<>`):,]|$)/gu, '临时目录');
    text = text.replace(/\/(?:Users|home)\/[^/\s"'<>`]+/g, '用户目录').replace(/\/private临时目录/g, '临时目录');
    if (!isSource) {
      text = text.replace(/(?<![\p{L}\p{N}_:])\/(?:work|app)\//gu, '');
      for (const [old, replacement] of systemRoots) text = text.replace(new RegExp('(?<![\\p{L}\\p{N}_:])' + escape(old) + '(?=/|[\\s"\'<>`):,]|$)', 'gu'), () => replacement);
    }
    return text;
  }

  async text(value, label, depth) {
    let result = '';
    let previous = 0;
    for (const match of value.matchAll(dataUri)) {
      result += this.plain(value.slice(previous, match.index), source(label));
      const body = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
      if (zipMagic(body)) {
        this.audit.embeddedZipArchivesValidated++;
        const normalized = await this.archive(body, label + '!embedded.zip', depth + 1);
        result += `data:${match[1]};base64,${normalized.toString('base64')}`;
      } else result += match[0];
      previous = match.index + match[0].length;
    }
    result += this.plain(value.slice(previous), source(label));
    const visible = result.replace(dataUri, '');
    if (/\/(?:Users|home)\/|\/(?:private\/)?var\/folders\/|file:\/\/\/(?:Users|home)\/|用户目录\/Desktop\//.test(visible)) {
      this.audit.unresolvedMachinePaths.push(this.plain(label));
    }
    return result;
  }

  async tree(value, label, depth) {
    if (typeof value === 'string') return this.text(value, label, depth);
    if (Array.isArray(value)) return Promise.all(value.map(item => this.tree(item, label, depth)));
    if (!value || typeof value !== 'object') return value;
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = await this.text(key, label, depth);
      if (Object.hasOwn(result, normalizedKey)) throw new Error('Normalization would merge JSON keys');
      result[normalizedKey] = await this.tree(item, label, depth);
    }
    return result;
  }

  async bytes(data, label, depth = 0) {
    if (depth > 8) throw new Error('Too many nested ZIP archives');
    if (zipMagic(data) || label.endsWith('.zip')) return this.archive(data, label, depth + 1);
    if (binary.has(extname(label)) || data.includes(0)) { this.audit.binaryPayloadsPreserved++; return data; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { this.audit.binaryPayloadsPreserved++; return data; }
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* Logs and source are plain text. */ }
    if (parsed !== undefined) {
      this.audit.jsonDocumentsValidated++;
      const normalized = await this.tree(parsed, label, depth);
      return JSON.stringify(parsed) === JSON.stringify(normalized) ? data : Buffer.from(JSON.stringify(normalized, null, 2) + '\n');
    }
    if (/\.(?:trace|network|jsonl|ndjson)$/.test(label)) {
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      let values;
      try { values = lines.map(line => JSON.parse(line)); } catch { /* Plain diagnostic log. */ }
      if (values) {
        this.audit.jsonlDocumentsValidated++;
        const normalized = await this.tree(values, label, depth);
        return JSON.stringify(values) === JSON.stringify(normalized) ? data : Buffer.from(normalized.map(value => JSON.stringify(value)).join('\n') + '\n');
      }
    }
    return Buffer.from(await this.text(text, label, depth));
  }

  async archive(data, label, depth) {
    if (depth > 8) throw new Error('Too many nested ZIP archives');
    this.audit.zipArchivesValidated++;
    const original = await readZip(data);
    const sources = new Map();
    for (const { entry } of original.entries) {
      const match = /^(?:src\/([a-f0-9]{40})(\.[^/]+)?|resources\/src@([a-f0-9]{40})\.txt)$/.exec(entry.fileName);
      if (match) { const id = match[1] ?? match[3]; sources.set(id, [...(sources.get(id) ?? []), entry.fileName]); }
    }
    const renames = new Map();
    const inspect = (value, file = false) => {
      if (typeof value === 'string' && file) {
        const names = sources.get(hash(value, 'sha1'));
        const normalized = this.plain(value);
        if (names && normalized !== value) for (const name of names) renames.set(name, name.replace(hash(value, 'sha1'), hash(normalized, 'sha1')));
      } else if (Array.isArray(value)) value.forEach(item => inspect(item, file));
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) inspect(item, key === 'file' || key === 'files');
    };
    if (sources.size) for (const { entry, body } of original.entries) {
      if (!/\.(?:trace|stacks|network|json)$/.test(entry.fileName)) continue;
      const text = body.toString('utf8');
      try { inspect(JSON.parse(text)); }
      catch { for (const line of text.split('\n')) { try { inspect(JSON.parse(line)); } catch { /* Non-JSON diagnostics. */ } } }
    }
    const entries = [];
    const names = new Set();
    let changed = false;
    for (const { entry, body: before } of original.entries) {
      const name = renames.get(entry.fileName) ?? this.plain(entry.fileName);
      if (names.has(name)) throw new Error('Normalization would merge ZIP entries');
      names.add(name);
      let body = await this.bytes(before, label + '!' + entry.fileName, depth);
      if (/\.(?:trace|stacks|network|json)$/.test(entry.fileName) && renames.size) {
        let text = body.toString('utf8');
        for (const [old, replacement] of renames) text = text.replaceAll(old, replacement);
        body = Buffer.from(text);
      }
      const comment = this.plain(entry.fileComment ?? '');
      changed ||= name !== entry.fileName || !body.equals(before) || comment !== (entry.fileComment ?? '');
      entries.push({ name, body, entry, comment });
    }
    const comment = this.plain(original.comment ?? '');
    changed ||= comment !== (original.comment ?? '');
    this.audit.sourceResourceLinksRemapped += renames.size;
    if (!changed) return data;
    const result = await writeZip(entries, comment);
    const checked = await readZip(result);
    assert.equal(checked.entries.length, entries.length);
    for (let index = 0; index < entries.length; index++) {
      assert.equal(checked.entries[index].entry.fileName, entries[index].name);
      assert.deepEqual(checked.entries[index].body, entries[index].body);
    }
    return result;
  }
}

/** Offline postprocessing after the owned local run stops. No product is started. */
export async function normalizeLocalArtifacts({ directory, repositoryRoot, executionRoot }) {
  if (![directory, repositoryRoot, executionRoot].every(value => typeof value === 'string' && value.length)) throw new Error('Artifact directory and both roots are required');
  const target = resolve(directory);
  const within = relative(resolve(repositoryRoot, 'qa/reports'), target);
  if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('Local artifacts must be under repository qa/reports');
  const normalizer = new Normalizer(repositoryRoot, executionRoot);
  const walk = async path => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Symlink artifacts are not normalized');
    if (info.isDirectory()) { for (const entry of (await readdir(path)).sort()) await walk(join(path, entry)); return; }
    if (!info.isFile()) throw new Error('Only ordinary artifact files are supported');
    if (basename(path) === 'prepared.json') throw new Error('Do not normalize an active prepared pointer');
    const before = await readFile(path);
    const after = await normalizer.bytes(before, path);
    normalizer.audit.checkedFiles++;
    if (!after.equals(before)) {
      const temporary = path + '.normalizing-' + process.pid;
      try { await writeFile(temporary, after, { flag: 'wx', mode: info.mode }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
      normalizer.audit.changedFiles.push({ path: normalizer.plain(path), beforeSha256: hash(before), afterSha256: hash(after) });
    }
  };
  await walk(target);
  normalizer.audit.directory = normalizer.plain(target);
  if (normalizer.audit.unresolvedMachinePaths.length) throw new Error('Artifact normalization left machine paths: ' + normalizer.audit.unresolvedMachinePaths.join(', '));
  return normalizer.audit;
}

async function selfTest() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  await mkdir(join(repositoryRoot, 'qa/reports'), { recursive: true });
  const directory = await mkdtemp(join(repositoryRoot, 'qa/reports/local-artifacts-self-check-'));
  const executionRoot = '/tmp/qa-local-fixture/candidate';
  const file = slash(repositoryRoot) + '/qa/tests/e2e/example.spec.ts';
  const originalId = hash(file, 'sha1');
  const normalizedId = hash('qa/tests/e2e/example.spec.ts', 'sha1');
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]);
  const imports = "import { x } from '../../../qa/fixtures/test.js';\nconst route = '/api/me';\nconst tool = '/usr/bin/node';\n";
  try {
    const trace = await writeZip([
      { name: 'trace.trace', body: Buffer.from(JSON.stringify({ type: 'before', file, line: 7, sha1: 'body.json' }) + '\n' + JSON.stringify({ type: 'after', file, status: 'failed' }) + '\n') },
      { name: 'trace.stacks', body: Buffer.from(JSON.stringify({ files: [file] })) },
      { name: `src/${originalId}.ts`, body: Buffer.from(imports) },
      { name: `resources/src@${originalId}.txt`, body: Buffer.from(imports) },
      { name: 'resources/body.json', body: Buffer.from(JSON.stringify({ status: 'failed', path: executionRoot + '/qa/tests/e2e/example.spec.ts', tool: '/usr/bin/node', route: '/api/me', uri: 'file://' + encodeURI(file) })) },
      { name: 'resources/image.png', body: image },
    ]);
    const report = await writeZip([{ name: 'report.json', body: Buffer.from(JSON.stringify({ file, attachments: [{ path: 'data/trace.zip' }] })) }]);
    await writeFile(join(directory, 'trace.zip'), trace);
    await writeFile(join(directory, 'index.html'), `<script>data:application/zip;base64,${report.toString('base64')}</script><img src="data:image/png;base64,${image.toString('base64')}">`);
    await writeFile(join(directory, 'cli.log'), `../../../../${slash(repositoryRoot).slice(1)}/qa/reports/trace.zip\n../../../..qa/reports/trace.zip\n`);
    const audit = await normalizeLocalArtifacts({ directory, repositoryRoot, executionRoot });
    const result = await readZip(await readFile(join(directory, 'trace.zip')));
    const files = new Map(result.entries.map(({ entry, body }) => [entry.fileName, body]));
    const events = files.get('trace.trace').toString().trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events[0].file, 'qa/tests/e2e/example.spec.ts');
    assert.equal(events[0].sha1, 'body.json');
    assert.equal(events[1].status, 'failed');
    assert.equal(JSON.parse(files.get('trace.stacks').toString()).files[0], 'qa/tests/e2e/example.spec.ts');
    assert.equal(files.get(`src/${normalizedId}.ts`).toString(), imports);
    assert.equal(files.get(`resources/src@${normalizedId}.txt`).toString(), imports);
    assert.equal(files.has(`src/${originalId}.ts`), false);
    assert.deepEqual(files.get('resources/image.png'), image);
    const body = JSON.parse(files.get('resources/body.json').toString());
    assert.equal(body.status, 'failed');
    assert.equal(body.tool, '系统工具目录/bin/node');
    assert.equal(body.route, '/api/me');
    assert.equal(body.uri, 'qa/tests/e2e/example.spec.ts');
    assert.equal(await readFile(join(directory, 'cli.log'), 'utf8'), 'qa/reports/trace.zip\nqa/reports/trace.zip\n');
    const html = await readFile(join(directory, 'index.html'), 'utf8');
    const embedded = await readZip(Buffer.from([...html.matchAll(dataUri)][0][2], 'base64'));
    const json = JSON.parse(embedded.entries[0].body.toString());
    assert.equal(json.file, 'qa/tests/e2e/example.spec.ts');
    assert.equal(json.attachments[0].path, 'data/trace.zip');
    assert.deepEqual(Buffer.from([...html.matchAll(dataUri)][1][2], 'base64'), image);
    const repeated = await normalizeLocalArtifacts({ directory, repositoryRoot, executionRoot });
    assert.equal(repeated.changedFiles.length, 0);
    return { purpose: 'local-artifact-tool-self-check', productTestsExecuted: false, passed: true, zipArchivesValidated: audit.zipArchivesValidated, sourceResourceLinksRemapped: audit.sourceResourceLinksRemapped, idempotent: true };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--self-test') {
  process.stdout.write(JSON.stringify(await selfTest()) + '\n');
}
