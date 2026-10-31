import { readFile } from 'node:fs/promises';
export interface ManualResult {
  id: string; result: '通过' | '失败' | '受阻' | '未执行';
  executedAt: string; executedBy: string; evidence: string[]; notes: string;
  reviewedClues?: { path: string; line: number }[];
}
export async function manualResults(candidateCommit: string): Promise<ManualResult[]> {
  if (!process.env.QA_MANUAL_RESULTS) return [];
  const value = JSON.parse(await readFile(process.env.QA_MANUAL_RESULTS, 'utf8')) as { candidateCommit: string; results: ManualResult[] };
  if (value.candidateCommit !== candidateCommit) throw new Error('Manual results belong to another candidate');
  for (const row of value.results) {
    if (!/^MAN-00[1-7]$/.test(row.id) || !['通过', '失败', '受阻', '未执行'].includes(row.result)) throw new Error('Invalid manual result');
    if (row.result === '通过' && (!row.executedBy || !row.executedAt || !row.evidence.length || !Number.isFinite(Date.parse(row.executedAt)))) throw new Error('Manual acceptance requires dated, attributed evidence');
  }
  if (new Set(value.results.map(row => row.id)).size !== value.results.length) throw new Error('Duplicate manual result');
  return value.results;
}
