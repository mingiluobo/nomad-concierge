#!/usr/bin/env python3
"""Offline QA artifact normalization. Never starts a server or reads outside target."""
import argparse
import base64
import copy
import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import quote

BINARY_SUFFIXES = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.webm', '.mp4', '.mov', '.mp3', '.wav', '.pdf', '.woff', '.woff2', '.ttf', '.otf'}
DATA_URI = re.compile(r'data:([\w.+/-]+);base64,([A-Za-z0-9+/=\r\n]+)')
LOCAL_PATH = re.compile(r'/(?:Users|home)/[^/\s"<>]+|/(?:private/)?var/folders/|/(?:private/)?(?:var/)?tmp(?:/|["\s]|$)|[A-Za-z]:[\\/]Users[\\/]', re.I)
SYSTEM_PATH = re.compile(r'(?<![\w:])/(?:work(?:/|["\s]|$)|root(?:/|["\s]|$)|usr/(?:local/)?(?:bin|lib|share)(?:/|["\s]|$)|s?bin(?:/|["\s]|$)|opt/homebrew/)')
EXTRA_SYSTEM_ROOTS = {
    '/var/lib/docker': '容器数据目录/docker', '/var/run': '系统运行目录', '/run': '系统运行目录',
    '/etc': '系统配置目录', '/dev': '系统设备目录', '/sys': '系统状态目录', '/proc': '系统状态目录/proc',
    '/Applications': '系统应用目录', '/System/Library': '系统资源目录', '/Library': '系统资源目录',
    '/usr/sbin': '系统工具目录/sbin', '/usr/libexec': '系统工具目录/libexec',
    '/data': '容器数据目录', '/Volumes': '挂载目录', '/mnt': '挂载目录', '/media': '挂载目录',
    '/workspace': '容器工作目录',
}
EXTRA_SYSTEM_PATH = re.compile(r'(?<![\w:])(?:' + '|'.join(re.escape(root) for root in [*EXTRA_SYSTEM_ROOTS, '/app']) + r')(?=/|[\s"\'<>`):,]|$)')

def digest(data):
    return hashlib.sha256(data).hexdigest()

class Normalizer:
    def __init__(self, repository_root, candidate_root=None, mappings=()):
        self.repo = str(Path(repository_root).resolve()).rstrip('/')
        entries = [(self.repo + '/', ''), (self.repo, '仓库根目录')]
        if candidate_root:
            candidate = str(Path(candidate_root).resolve()).rstrip('/')
            display = '临时目录/' + Path(candidate).parent.name + '/' + Path(candidate).name
            entries.extend([(candidate + '/qa/', 'qa/'), (candidate, display)])
        entries.extend(mappings)
        for old, new in list(entries):
            if old.startswith(('/var/', '/tmp/')):
                entries.append(('/private' + old, new))
            elif old.startswith(('/private/var/', '/private/tmp/')):
                entries.append((old[len('/private'):], new))
        entries.extend((quote(old, safe='/'), new) for old, new in list(entries))
        self.mappings = sorted(entries, key=lambda item: len(item[0]), reverse=True)
        self.zip_count = 0
        self.embedded_zip_count = 0
        self.json_count = 0
        self.jsonl_count = 0
        self.binary_count = 0
        self.source_links_renamed = 0
        self.findings = []

    @staticmethod
    def source_label(label):
        return '/src@' in label or label.endswith(('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'))

    def plain(self, text, source=False):
        if '/' not in text and '\\' not in text:
            return text
        text = re.sub(r'file://(?=/(?:Users|home|private|var/folders|tmp)/)', '', text)
        if not source and ('../' in text or '..qa/' in text):
            # Some CLI reporters relativize an absolute artifact path from a
            # temporary working directory, producing ../../Users/... . Consume
            # that whole known-root prefix before the absolute-root mapping.
            for old, new in self.mappings:
                if not old.startswith('/'):
                    continue
                pattern = r'(?<![\w./])(?:\.\./)+' + re.escape(old.lstrip('/'))
                if not old.endswith('/'):
                    pattern += r'(?=/|[\s"\'<>`):,]|$)'
                text = re.sub(pattern, lambda _: new, text)
            # Repair the exact malformed prefix emitted by older normalization.
            # Keep this out of source files so relative imports remain untouched.
            text = re.sub(r'(?<![\w./])(?:\.\./)*\.\.qa/', 'qa/', text)
        for old, new in self.mappings:
            # A mapping is a complete root or a root plus slash, never a partial directory name.
            if old.endswith('/'):
                text = text.replace(old, new)
            else:
                text = re.sub(re.escape(old) + r'(?=/|[\s"\'<>`):,]|$)', lambda _: new, text)
        text = re.sub(r'/(?:private/)?var/folders/[^/\s"<>]+/[^/\s"<>]+/[TC]/', '临时目录/', text)
        text = re.sub(r'(?<![\w:])/(?:private/)?(?:var/)?tmp(?=/|[\s"\'<>`):,]|$)', '临时目录', text)
        text = re.sub(r'/(?:Users|home)/[^/\s"\'<>`]+', '用户目录', text)
        text = re.sub(r'[A-Za-z]:[\\/]Users[\\/][^\\/\s"<>]+', '用户目录', text)
        text = text.replace('/private临时目录', '临时目录')
        if not source:
            text = re.sub(r'(?<![\w:])/work/', '', text)
            text = re.sub(r'(?<![\w:])/work(?=[\s"\'<>`):,]|$)', '仓库根目录', text)
            text = re.sub(r'(?<![\w:])/app/', '', text)
            text = re.sub(r'(?<![\w:])/app(?=[\s"\'<>`):,]|$)', '仓库根目录', text)
            text = re.sub(r'(?<![\w:])/root/\.npm(?=/|[\s"\'<>`):,]|$)', '容器缓存目录/npm', text)
            text = re.sub(r'(?<![\w:])/root/\.cache(?=/|[\s"\'<>`):,]|$)', '容器缓存目录', text)
            text = re.sub(r'(?<![\w:])/root(?=/|[\s"\'<>`):,]|$)', '容器用户目录', text)
            text = re.sub(r'(?<![\w:])/usr/(?:local/)?(bin|lib|share)(?=/|[\s"\'<>`):,]|$)', lambda match: '系统工具目录/' + match.group(1), text)
            text = re.sub(r'(?<![\w:])/(s?bin)(?=/|[\s"\'<>`):,]|$)', lambda match: '系统工具目录/' + match.group(1), text)
            text = re.sub(r'(?<![\w:])/opt/homebrew(?=/|[\s"\'<>`):,]|$)', '系统工具目录/homebrew', text)
            for old, new in sorted(EXTRA_SYSTEM_ROOTS.items(), key=lambda item: len(item[0]), reverse=True):
                text = re.sub(r'(?<![\w:])' + re.escape(old) + r'(?=/|[\s"\'<>`):,]|$)', lambda _: new, text)
        return text

    def display(self, path):
        return self.plain(str(path))

    def tree(self, value, label, depth):
        if isinstance(value, str):
            return self.text(value, label, depth)
        if isinstance(value, list):
            return [self.tree(item, label, depth) for item in value]
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                normalized_key = self.text(key, label, depth)
                if normalized_key in result:
                    raise ValueError('Normalization would merge JSON keys at ' + self.display(label))
                result[normalized_key] = self.tree(item, label, depth)
            return result
        return value

    def text(self, text, label, depth=0):
        if '/' not in text and '\\' not in text:
            return text
        source = self.source_label(label)
        pieces = []
        offset = 0
        for match in DATA_URI.finditer(text):
            pieces.append(self.plain(text[offset:match.start()], source))
            token = match.group(0)
            payload = base64.b64decode(re.sub(r'\s+', '', match.group(2)), validate=True)
            if zipfile.is_zipfile(io.BytesIO(payload)):
                self.embedded_zip_count += 1
                changed = self.archive(payload, label + '!embedded.zip', depth + 1)
                token = 'data:' + match.group(1) + ';base64,' + base64.b64encode(changed).decode('ascii')
            # Preserve encoded pictures, video and other non-ZIP payloads byte for byte.
            pieces.append(token)
            offset = match.end()
        pieces.append(self.plain(text[offset:], source))
        result = ''.join(pieces)
        self.scan_text(result, label, source)
        return result

    def scan_text(self, text, label, source=False):
        # Encoded binaries are inspected only if they are ZIPs, by archive().
        visible = DATA_URI.sub('', text)
        for pattern, kind in [(LOCAL_PATH, 'machine-path'), (SYSTEM_PATH, 'container-or-system-path'), (EXTRA_SYSTEM_PATH, 'container-or-system-path')]:
            if source and kind == 'container-or-system-path':
                continue  # Normal source-code system constants are not machine identifiers.
            if pattern.search(visible):
                self.findings.append({'path': self.display(label), 'kind': kind})
        if '用户目录/Desktop/' in visible:
            self.findings.append({'path': self.display(label), 'kind': 'unmapped-checkout-prefix'})

    def bytes(self, data, label, depth=0):
        if depth > 8:
            raise ValueError('Too many nested archives at ' + self.display(label))
        if zipfile.is_zipfile(io.BytesIO(data)):
            return self.archive(data, label, depth + 1)
        if Path(label).suffix.lower() in BINARY_SUFFIXES or b'\x00' in data:
            self.binary_count += 1
            return data
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            self.binary_count += 1
            return data
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            parsed = None
            whole_json = False
        else:
            whole_json = True
        if whole_json:
            self.json_count += 1
            normalized = self.tree(parsed, label, depth)
            result = text if normalized == parsed else json.dumps(normalized, ensure_ascii=False, indent=2) + '\n'
            json.loads(result)
            return result.encode('utf-8')
        if label.endswith(('.trace', '.network', '.jsonl', '.ndjson')):
            lines = text.splitlines(keepends=True)
            try:
                values = [json.loads(line) for line in lines if line.strip()]
            except ValueError:
                pass
            else:
                self.jsonl_count += 1
                normalized = [self.tree(value, label, depth) for value in values]
                if normalized == values:
                    return data
                return ('\n'.join(json.dumps(value, ensure_ascii=False, separators=(',', ':')) for value in normalized) + '\n').encode('utf-8')
        return self.text(text, label, depth).encode('utf-8')

    def archive(self, data, label, depth):
        if depth > 8:
            raise ValueError('Too many nested archives at ' + self.display(label))
        self.zip_count += 1
        output = io.BytesIO()
        changed = False
        names = set()
        entries = []
        with zipfile.ZipFile(io.BytesIO(data)) as original, zipfile.ZipFile(output, 'w') as normalized:
            # Trace Viewer requests src/SHA1(stack.file).ext (or legacy src@SHA1).
            # Renaming stack files therefore requires matching resource-entry names.
            source_names = {}
            for name in original.namelist():
                match = re.match(r'^(?:src/([a-f0-9]{40})(\.[^/]+)?|resources/src@([a-f0-9]{40})\.txt)$', name)
                if match:
                    source_names.setdefault(match.group(1) or match.group(3), []).append(name)
            renames = {}
            def inspect_sources(value, is_file=False):
                if isinstance(value, str) and is_file:
                    source_hash = hashlib.sha1(value.encode('utf-8')).hexdigest()
                    if source_hash in source_names:
                        new_path = self.plain(value)
                        new_hash = hashlib.sha1(new_path.encode('utf-8')).hexdigest()
                        if new_path != value:
                            for name in source_names[source_hash]:
                                renames[name] = name.replace(source_hash, new_hash)
                elif isinstance(value, list):
                    for item in value:
                        inspect_sources(item, is_file)
                elif isinstance(value, dict):
                    for key, item in value.items():
                        inspect_sources(item, key in ('file', 'files'))
            if source_names:
                for info in original.infolist():
                    if not info.filename.endswith(('.trace', '.stacks', '.network', '.json')):
                        continue
                    try:
                        content = original.read(info).decode('utf-8')
                    except UnicodeDecodeError:
                        continue
                    try:
                        inspect_sources(json.loads(content))
                    except ValueError:
                        for line in content.splitlines():
                            try:
                                inspect_sources(json.loads(line))
                            except ValueError:
                                pass
            self.source_links_renamed += len(renames)
            for info in original.infolist():
                new_info = copy.copy(info)
                new_info.filename = renames.get(info.filename, self.plain(info.filename))
                if new_info.filename in names:
                    raise ValueError('Normalization would merge ZIP entries at ' + self.display(label))
                names.add(new_info.filename)
                before = original.read(info)
                after = self.bytes(before, label + '!' + info.filename, depth)
                if info.filename.endswith(('.trace', '.stacks', '.network', '.json')):
                    for old_name, new_name in renames.items():
                        after = after.replace(old_name.encode(), new_name.encode())
                changed |= before != after or new_info.filename != info.filename
                entries.append((new_info, after))
            try:
                comment = self.text(original.comment.decode('utf-8'), label + '!comment', depth).encode('utf-8')
            except UnicodeDecodeError:
                comment = original.comment
            normalized.comment = comment
            changed |= comment != original.comment
            # No recompression is needed for an unchanged archive during a check.
            if changed:
                for info, content in entries:
                    normalized.writestr(info, content)
        result = output.getvalue() if changed else data
        with zipfile.ZipFile(io.BytesIO(result)) as checked:
            if checked.testzip() is not None:
                raise ValueError('Invalid ZIP CRC at ' + self.display(label))
        return result

def make_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()

def self_test(directory):
    directory.mkdir(parents=True, exist_ok=True)
    root = '/Users/qa-user/Workspace with spaces/project'
    candidate = '/private/var/folders/aa/bb/T/nc-qa-candidate-fixture/candidate'
    normalizer = Normalizer(root, candidate)
    png = b'\x89PNG\r\n\x1a\n\x00binary-preserved'
    event = {'type': 'before', 'file': root + '/qa/tests/ws/protocol.spec.ts', 'line': 17,
             'db': '/var/folders/aa/bb/T/nc-qa-instance-fixture/qa.sqlite', 'node': '/usr/bin/node',
             'route': '/api/conversations', 'signal': 'SIGTERM', 'sha1': 'body.json',
             'uri': 'file://' + quote(root + '/qa/tests/ws/protocol.spec.ts', safe='/')}
    source_hash = hashlib.sha1(event['file'].encode()).hexdigest()
    trace = make_zip({'trace.trace': json.dumps(event) + '\n',
                      'trace.network': json.dumps({'request': {'url': 'http://127.0.0.1:1234/api/me'}, 'body': '/work/qa/trace.txt'}) + '\n',
                      'trace.stacks': json.dumps({'files': [root + '/qa/tests/ws/protocol.spec.ts']}),
                      'resources/body.json': json.dumps({'result': '失败', 'id': 'D-001', 'path': candidate + '/apps/api/dist/server.js'}),
                      'src/' + source_hash + '.ts': "const tool = '/usr/bin/node'; const route = '/api/me';\n// " + root + '/qa/tests/ws/protocol.spec.ts',
                      'resources/image.png': png})
    report = make_zip({'report.json': json.dumps({'attachments': [{'path': 'data/trace.zip'}], 'file': root + '/qa/tests/ws/protocol.spec.ts'})})
    html = '<html><script id="playwrightReportBase64">data:application/zip;base64,' + base64.b64encode(report).decode() + '</script><img src="data:image/png;base64,' + base64.b64encode(png).decode() + '"></html>'
    cli_paths = '\n'.join([
        '../' * 9 + root.lstrip('/') + '/qa/reports/trace.zip',
        '../' * 9 + quote(root.lstrip('/'), safe='/') + '/qa/reports/trace.zip',
        '../' * 8 + '..qa/reports/trace.zip',
    ]) + '\n'
    relative_imports = "import { value } from '../../../../qa/fixtures/example.js';\nimport other from '../support.js';\n"
    fixtures = {'trace.zip': trace, 'index.html': html.encode(),
                'metadata.json': json.dumps({'root': root, 'candidate': candidate, 'cache': '/root/.npm/_logs/check.log', 'status': 'failed'}).encode(),
                'cli-paths.log': cli_paths.encode(), 'relative-imports.ts': relative_imports.encode()}
    outputs = {}
    for name, before in fixtures.items():
        after = normalizer.bytes(before, name)
        (directory / name).write_bytes(after)
        outputs[name] = after
    with zipfile.ZipFile(io.BytesIO(outputs['trace.zip'])) as archive:
        assert archive.testzip() is None
        actual = json.loads(archive.read('trace.trace'))
        assert actual['file'] == 'qa/tests/ws/protocol.spec.ts' and actual['line'] == 17
        assert actual['uri'] == 'qa/tests/ws/protocol.spec.ts'
        assert actual['route'] == '/api/conversations' and actual['signal'] == 'SIGTERM'
        assert actual['sha1'] == 'body.json' and 'resources/' + actual['sha1'] in archive.namelist()
        assert archive.read('resources/image.png') == png
        new_source_hash = hashlib.sha1(actual['file'].encode()).hexdigest()
        assert 'src/' + source_hash + '.ts' not in archive.namelist()
        assert "'/usr/bin/node'" in archive.read('src/' + new_source_hash + '.ts').decode()
        assert json.loads(archive.read('resources/body.json'))['id'] == 'D-001'
    uris = list(DATA_URI.finditer(outputs['index.html'].decode()))
    assert len(uris) == 2
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(uris[0].group(2)))) as archive:
        assert archive.testzip() is None
        report_json = json.loads(archive.read('report.json'))
        assert report_json['attachments'][0]['path'] == 'data/trace.zip'
        assert report_json['file'] == 'qa/tests/ws/protocol.spec.ts'
    assert base64.b64decode(uris[1].group(2)) == png
    assert json.loads(outputs['metadata.json'])['status'] == 'failed'
    assert outputs['cli-paths.log'].decode() == 'qa/reports/trace.zip\n' * 3
    assert outputs['relative-imports.ts'].decode() == relative_imports
    assert not normalizer.findings, normalizer.findings
    repeated = Normalizer(root, candidate)
    for name, after in outputs.items():
        assert repeated.bytes(after, name) == after
    assert not repeated.findings
    result = {'purpose': 'qa-tool-self-check', 'productTestsExecuted': False, 'passed': True,
              'checks': ['ZIP CRC', 'embedded report ZIP', 'JSON and JSONL parsing', 'resource reference preservation', 'SHA1 source-link remapping', 'binary preservation', 'HTTP route and signal preservation', 'source system constant preservation', 'CLI relative root normalization', 'malformed QA prefix repair', 'relative source import preservation', 'idempotent bytes', 'no machine paths']}
    (directory / 'self-test-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['self-test', 'check', 'apply'])
    parser.add_argument('--repository-root')
    parser.add_argument('--candidate-root')
    parser.add_argument('--target')
    parser.add_argument('--map', action='append', default=[])
    parser.add_argument('--audit')
    args = parser.parse_args()
    if args.mode == 'self-test':
        if not args.target:
            parser.error('self-test requires an explicit ignored output directory')
        self_test(Path(args.target))
        return
    if not args.repository_root or not args.target:
        parser.error('check/apply requires --repository-root and --target')
    repo = Path(args.repository_root).resolve()
    target = Path(args.target).resolve()
    if not target.is_dir() or not target.is_relative_to(repo / 'qa' / 'reports'):
        parser.error('target must be an existing directory under repository qa/reports')
    mappings = []
    for item in args.map:
        before, separator, after = item.partition('=')
        if not separator or not before:
            parser.error('--map requires FROM=TO')
        mappings.append((before, after))
    normalizer = Normalizer(repo, args.candidate_root, mappings)
    changes = []
    checked = 0
    audit = Path(args.audit).resolve() if args.audit else target / ('path-portability-' + args.mode + '-audit.json')
    if not audit.is_relative_to(repo / 'qa' / 'reports'):
        parser.error('audit must be under repository qa/reports')
    for path in sorted(target.rglob('*')):
        if not path.is_file() or path == audit:
            continue
        if path.is_symlink():
            raise ValueError('Symlink artifacts must be reviewed separately')
        if path.name == 'prepared.json':
            raise ValueError('Refusing a live prepared.json pointer; wait for execution cleanup')
        before = path.read_bytes()
        after = normalizer.bytes(before, str(path))
        checked += 1
        if after != before:
            changes.append({'path': normalizer.display(path), 'beforeSha256': digest(before), 'afterSha256': digest(after)})
            if args.mode == 'apply':
                path.write_bytes(after)
    result = {'purpose': 'artifact-path-normalization', 'mode': args.mode, 'productTestsExecuted': False,
              'target': normalizer.display(target), 'checkedFiles': checked, 'changedFiles': changes,
              'zipArchivesValidated': normalizer.zip_count, 'embeddedZipArchivesValidated': normalizer.embedded_zip_count,
              'jsonDocumentsValidated': normalizer.json_count, 'jsonlDocumentsValidated': normalizer.jsonl_count,
              'binaryPayloadsPreserved': normalizer.binary_count, 'unresolvedMachinePaths': normalizer.findings,
              'sourceResourceLinksRemapped': normalizer.source_links_renamed,
              'originalExecutionChecksumsPreservedAsHistoricalFacts': True,
              'note': 'Final published-file checksums must be generated after normalization. check mode validates proposed normalized bytes without changing artifacts.'}
    audit.parent.mkdir(parents=True, exist_ok=True)
    audit.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['mode', 'checkedFiles', 'zipArchivesValidated', 'embeddedZipArchivesValidated', 'unresolvedMachinePaths']}, ensure_ascii=False))
    print('changedFiles=' + str(len(changes)))
    if normalizer.findings:
        sys.exit(2)
    if args.mode == 'check' and changes:
        sys.exit(1)

if __name__ == '__main__':
    main()
