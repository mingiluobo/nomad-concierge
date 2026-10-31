import type { Reporter, TestCase, TestResult, FullResult, Suite } from '@playwright/test/reporter';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export interface CaseResult { id: string; title: string; result: string; duration: number; evidence: string[]; errors: string[]; priority?: string }
export default class EvidenceReporter implements Reporter {
  private rows = new Map<string, CaseResult>();
  onBegin(_config: unknown, suite: Suite) {
    for (const test of suite.allTests()) {
      const id = test.title.match(/(?:API|WS|E2E|ENV)-\d{3}/)?.[0] ?? test.title;
      this.rows.set(test.id, { id, title: test.title, result: '未执行', duration: 0, evidence: [], errors: [] });
    }
  }
  async onTestEnd(test: TestCase, result: TestResult) {
    const row = this.rows.get(test.id)!;
    row.errors = result.errors.map(error => error.message ?? String(error));
    row.result = result.status === 'skipped' ? '跳过' : row.errors.some(message => message.includes('BLOCKED:')) ? '受阻' : result.status === 'passed' ? (result.retry ? '不稳定' : '通过') : '失败';
    row.duration += result.duration;
    for (const attachment of result.attachments) {
      let source = attachment.path;
      if (!source && attachment.body && process.env.QA_RUN_DIR) {
        const directory = join(process.env.QA_RUN_DIR, `round-${process.env.QA_ROUND}`, 'attachments');
        await mkdir(directory, { recursive: true });
        source = join(directory, `${row.id}-retry${result.retry}-${row.evidence.length}-${attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
        await writeFile(source, attachment.body);
      }
      if (!source) continue;
      row.evidence.push(source);
      if (attachment.contentType.startsWith('video/') && process.env.QA_REPORT_ROOT && process.env.QA_RUN_DIR) {
        const videoDirectory = join(process.env.QA_REPORT_ROOT, 'videos');
        await mkdir(videoDirectory, { recursive: true });
        const path = join(videoDirectory, `${basename(process.env.QA_RUN_DIR)}-r${process.env.QA_ROUND}-${row.id}-${row.evidence.length}.webm`);
        await copyFile(source, path);
        row.evidence.push(path);
      }
    }
  }
  async onEnd(result: FullResult) {
    if (process.env.QA_EXECUTION_AUTHORIZED !== 'candidate' || !process.env.QA_RUN_DIR) return;
    const destination = resolve(process.env.QA_RUN_DIR, `round-${process.env.QA_ROUND}`, 'results.json');
    await mkdir(resolve(destination, '..'), { recursive: true });
    await writeFile(destination, JSON.stringify({ status: result.status, rows: [...this.rows.values()] }, null, 2));
  }
}
