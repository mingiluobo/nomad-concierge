import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { interpretationSchema, profileSchema, slotKeySchema } from '@nomad/shared';
import type { EngineId, Interpretation, Profile, SlotUpdate } from '@nomad/shared';
import { loadConfig } from '../src/config.js';
import { mergeInterpretation, reconcile } from '../src/domain/profile.js';
import { EngineRegistry } from '../src/agent/engines.js';
import { InterpreterError } from '../src/agent/interpreter.js';
import type { Interpreter } from '../src/agent/interpreter.js';
import { RulesInterpreter } from '../src/agent/rules/index.js';
import { LlmInterpreter } from '../src/agent/llm/llmInterpreter.js';
import { PROMPT_VERSION } from '../src/agent/llm/prompt.js';

const goldenSchema = z.object({ id: z.string(), input: z.object({ profile: profileSchema, pendingSlots: z.array(slotKeySchema), text: z.string() }), expected: interpretationSchema, tags: z.array(z.string()), reviewed: z.boolean() });
export type GoldenCase = z.infer<typeof goldenSchema>;
function normalizeValue(slot: SlotUpdate['slot'], value: unknown): unknown { return slot === 'goals' && Array.isArray(value) ? [...new Set(value)].sort() : value; }
export function updateKey(update: SlotUpdate): string { return JSON.stringify([update.slot, normalizeValue(update.slot, update.value), update.op ?? (update.slot === 'goals' ? 'add' : 'set')]); }
function semanticProfile(profile: Profile, interpretation: Interpretation): unknown {
  const merged = mergeInterpretation(profile, interpretation, 'evaluation-message', '2000-01-01T00:00:00.000Z');
  const result = reconcile(profile, merged.profile, merged.providedSlots).profile;
  return Object.fromEntries(Object.entries(result.slots).map(([slot, state]) => [slot, { ...state, ...(state.value !== undefined ? { value: normalizeValue(slot as SlotUpdate['slot'], state.value) } : {}), ...(state.previousValue !== undefined ? { previousValue: normalizeValue(slot as SlotUpdate['slot'], state.previousValue) } : {}) }]));
}
export function compareInterpretation(actual: Interpretation, expected: Interpretation, profile: Profile) {
  const predicted = new Set(actual.updates.map(updateKey));
  const desired = new Set(expected.updates.map(updateKey));
  const matched = [...predicted].filter(key => desired.has(key)).length;
  return {
    intent: actual.intent === expected.intent,
    predicted: predicted.size, expected: desired.size, matched,
    unsure: JSON.stringify([...new Set(actual.unsure)].sort()) === JSON.stringify([...new Set(expected.unsure)].sort()),
    semantic: JSON.stringify(semanticProfile(profile, actual)) === JSON.stringify(semanticProfile(profile, expected)),
  };
}
export interface EvaluationResult {
  engine: EngineId; attempted: number; succeeded: number; intent: number; matched: number; predicted: number; expected: number; unsure: number; semantic: number; elapsedMs: number;
  failures: Record<string, number>; skipped: { id: string; reason: string }[];
}
export async function evaluate(engine: Interpreter, engineId: EngineId, cases: GoldenCase[], timeoutMs: number): Promise<EvaluationResult> {
  const result: EvaluationResult = { engine: engineId, attempted: 0, succeeded: 0, intent: 0, matched: 0, predicted: 0, expected: 0, unsure: 0, semantic: 0, elapsedMs: 0, failures: {}, skipped: [] };
  for (const item of cases) {
    if (engineId === 'rules' && !item.tags.includes('rules')) { result.skipped.push({ id: item.id, reason: 'llm-only case' }); continue; }
    result.attempted += 1;
    const started = performance.now();
    try {
      const output = await engine.interpret({ profile: item.input.profile, pendingSlots: item.input.pendingSlots, recentMessages: [], newMessages: [{ id: item.id, content: item.input.text }] }, AbortSignal.timeout(timeoutMs));
      const comparison = compareInterpretation(output.interpretation, item.expected, item.input.profile);
      result.succeeded += 1; result.intent += Number(comparison.intent); result.matched += comparison.matched; result.predicted += comparison.predicted;
      result.expected += comparison.expected; result.unsure += Number(comparison.unsure); result.semantic += Number(comparison.semantic);
    } catch (error) {
      const reason = error instanceof InterpreterError ? error.reason : error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'error';
      result.failures[reason] = (result.failures[reason] ?? 0) + 1;
      result.expected += new Set(item.expected.updates.map(updateKey)).size;
    } finally { result.elapsedMs += performance.now() - started; }
  }
  return result;
}
const fraction = (number: number, denominator: number) => denominator ? `${number}/${denominator} (${(number / denominator * 100).toFixed(1)}%)` : '0/0 (n/a)';
export async function main(args = process.argv.slice(2)): Promise<string> {
  const position = args.indexOf('--engines');
  const selected = (position < 0 ? 'rules' : args[position + 1] ?? '').split(',');
  if (!selected.length || selected.some(id => !['rules', 'remote', 'local'].includes(id))) throw new Error('Use --engines rules,remote,local with at least one supported engine');
  const ids = [...new Set(selected)] as EngineId[];
  const text = await readFile(new URL('../test/fixtures/golden-cases.json', import.meta.url), 'utf8');
  const cases = z.array(goldenSchema).parse(JSON.parse(text));
  const config = loadConfig({ ...process.env, ...(!ids.includes('remote') ? { LLM_API_KEY: '' } : {}), ...(!ids.includes('local') ? { LOCAL_LLM_MODEL: '' } : {}) });
  const registry = new EngineRegistry(config);
  const results: EvaluationResult[] = [];
  const skipped: string[] = [];
  const models: string[] = [];
  try {
    await registry.start();
    for (const id of ids) {
      const status = registry.status().find(status => status.id === id)!;
      if (!status.available) { skipped.push(`${id}: ${status.reason}; skipped ${cases.length} cases (${cases.map(item => item.id).join(', ')})`); continue; }
      const engine = id === 'rules' ? new RulesInterpreter() : new LlmInterpreter(id, id === 'remote'
        ? { baseUrl: config.llmBaseUrl, model: config.llmModel, apiKey: config.llmApiKey, timeoutMs: config.llmTimeoutMs }
        : { baseUrl: config.localLlmBaseUrl, model: config.localLlmModel, apiKey: 'local', timeoutMs: config.localLlmTimeoutMs });
      models.push(`${id}: ${status.model ?? 'deterministic rules'}`);
      results.push(await evaluate(engine, id, cases, config.turnTimeoutMs));
    }
  } finally { registry.dispose(); }
  const lines = [
    '# Interpretation evaluation', '', `Run time: ${new Date().toISOString()}`, `Dataset SHA-256: ${createHash('sha256').update(text).digest('hex')}`,
    `Dataset: ${cases.length} cases; tags: ${[...new Set(cases.flatMap(item => item.tags))].sort().join(', ')}; key cases reviewed: ${cases.filter(item => item.tags.includes('key') && item.reviewed).length}/${cases.filter(item => item.tags.includes('key')).length}`,
    `Models: ${models.join('; ') || 'none available'}`, `Prompt version: ${PROMPT_VERSION} (LLM only; rules: n/a)`, '',
    '| Engine | Intent accuracy | Update precision | Update recall | Unsure accuracy | Semantic accuracy | Average ms | Failures |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(result => `| ${result.engine} | ${fraction(result.intent, result.attempted)} | ${fraction(result.matched, result.predicted)} | ${fraction(result.matched, result.expected)} | ${fraction(result.unsure, result.attempted)} | ${fraction(result.semantic, result.attempted)} | ${(result.elapsedMs / Math.max(1, result.attempted)).toFixed(2)} | ${JSON.stringify(result.failures)} |`),
    '', 'Update matches compare (slot, normalized value, operation); absent operations mean add for goals and set otherwise. Goal values are compared as sets. Semantic accuracy compares the resulting reconciled profiles. Failed cases remain in accuracy/recall denominators.',
    '', 'Skipped cases / engines:', ...skipped.map(item => `- ${item}`), ...results.flatMap(result => result.skipped.map(item => `- ${result.engine} ${item.id}: ${item.reason}`)),
  ];
  if (!skipped.length && results.every(result => !result.skipped.length)) lines.push('- None.');
  const report = lines.join('\n') + '\n';
  await writeFile(new URL('../../../docs/eval-results.md', import.meta.url), report);
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(report => process.stdout.write(report)).catch(error => { console.error(error instanceof Error ? error.message : 'Evaluation failed'); process.exitCode = 1; });
}
