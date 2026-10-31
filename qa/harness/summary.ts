import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cases } from '../catalog/index.js';
import { matrix, cell } from './documents.js';
import type { Candidate } from './candidate.js';
import type { CaseResult } from './reporter.js';
import { manualResults } from './manual.js';

export async function writeSummary(reportRoot: string, runDirectory: string, info: Candidate, mode: string, operationalError?: string): Promise<boolean> {
  const rows: (CaseResult & { round: string })[] = [];
  const runnerErrors: string[] = operationalError ? [operationalError] : [];
  for (const directory of await readdir(runDirectory)) {
    if (!directory.startsWith('round-')) continue;
    try { const parsed = JSON.parse(await readFile(join(runDirectory, directory, 'results.json'), 'utf8')) as { status: string; rows: CaseResult[] }; rows.push(...parsed.rows.map(row => ({ ...row, round: directory }))); if (parsed.status !== 'passed') runnerErrors.push(`${directory}: runner status ${parsed.status}`); } catch { /* Missing result means not executed, never success. */ }
  }
  for (const row of await manualResults(info.candidateCommit)) rows.push({ ...row, title: row.id, round: '人工登记', duration: 0, errors: [] });
  const result = (id: string): string => {
    const found = rows.filter(row => row.id === id);
    const definition = cases.find(row => row.id === id)!;
    const required = definition.type === 'manual' ? 1 : definition.type === 'env' ? 1 : 3;
    const bad = ['失败', '受阻', '不稳定', '跳过'].find(state => found.some(row => row.result === state));
    if (bad) return bad;
    return found.length === required && found.every(row => row.result === '通过') ? '通过' : found.length ? `未执行（已完成 ${found.length}/${required} 轮）` : '未执行';
  };
  let defectsReviewed = false;
  let defectDescription = '尚未登记同候选缺陷审阅；不据此宣称零缺陷。';
  if (process.env.QA_DEFECT_REVIEW) {
    const review = JSON.parse(await readFile(process.env.QA_DEFECT_REVIEW, 'utf8')) as { candidateCommit: string; reviewedBy: string; reviewedAt: string; items: { id: string; priority: string; status: string; evidence: string }[] };
    if (review.candidateCommit !== info.candidateCommit || !review.reviewedBy || !Number.isFinite(Date.parse(review.reviewedAt))) throw new Error('Invalid candidate defect review');
    defectsReviewed = review.items.every(item => Boolean(item.evidence) && (item.status === 'closed' || (['P2', 'P3'].includes(item.priority) && item.status === 'accepted')));
    defectDescription = `缺陷审阅：${review.reviewedBy}，${review.reviewedAt}；${review.items.map(item => `${item.id} ${item.priority} ${item.status} ${item.evidence}`).join('; ') || '已登记无缺陷'}。`;
  }
  const pass = cases.every(row => result(row.id) === '通过') && !runnerErrors.length && mode === 'full' && defectsReviewed;
  const lines = ['# Nomad Concierge QA 执行报告', '', `时间：${new Date().toISOString()}；运行目录：${runDirectory}；模式：${mode}。`, '',
    `候选：${info.candidateCommit}；产品：${info.productCommit}；QA：${info.qaCommit}；契约：${info.specVersion}。`,
    `README SHA-256：${info.readmeSha256}；锁文件 SHA-256：${info.lockSha256}。环境、构建方式和实际进程见 metadata.json、build.log 及每例 instance.json。`, '',
    `结论：${pass ? '同候选的用例、轮次、人工登记与缺陷处置符合进入下一环节的要求。' : '不可放行：有未通过、未执行、未登记的必测项或缺陷处置。'}`, '',
    runnerErrors.length ? `运行错误：${runnerErrors.join('; ')}` : '',
    '| 类型 | 用例数 | 通过数 | 通过率 |', '| --- | --- | --- | --- |',
    ...['api', 'e2e', 'ws', 'env', 'manual'].map(type => { const selected = cases.filter(row => row.type === type); const count = selected.filter(row => result(row.id) === '通过').length; return `| ${type} | ${selected.length} | ${count} | ${Math.round(count / selected.length * 100)}% |`; }), '',
    '| 优先级 | 用例数 | 通过数 |', '| --- | --- | --- |',
    ...['P0', 'P1', 'P2', 'P3'].map(priority => { const selected = cases.filter(row => row.priority === priority); return `| ${priority} | ${selected.length} | ${selected.filter(row => result(row.id) === '通过').length} |`; }), '',
    '## 每例状态及轮次', '', '| 用例 | 汇总状态 | 实际轮次 |', '| --- | --- | --- |',
    ...cases.map(row => `| ${row.id} | ${result(row.id)} | ${rows.filter(item => item.id === row.id).map(item => `${item.round}: ${item.result}`).join('; ') || '无'} |`), '',
    '## 完整追踪矩阵', '', matrix(result), '', '## 证据清单', '', '| 用例 | 轮次 | 文件 |', '| --- | --- | --- |',
    ...rows.flatMap(row => row.evidence.map(path => `| ${row.id} | ${row.round} | ${cell(path)} |`)), '',
    '## 缺陷与人工项', '', defectDescription, '', '自动测试失败不自动等同产品缺陷；需复核环境、契约与复现证据后在 defects/ 登记。特别标记由 QA 首次发现而开发自测未发现的缺陷。人工项见 checklists/acceptance.md，未签认均为未执行。', '',
    ...rows.filter(row => row.errors.length).map(row => `- ${row.id} ${row.round}：${cell(row.errors.join('; '))}`), '',
  ];
  await writeFile(join(runDirectory, 'summary.md'), lines.join('\n'));
  await writeFile(join(reportRoot, 'summary.md'), lines.join('\n'));
  return pass;
}
