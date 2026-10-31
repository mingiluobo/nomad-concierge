import { describe, expect, it } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import { compareInterpretation, evaluate, updateKey } from '../../scripts/eval.js';
import type { GoldenCase } from '../../scripts/eval.js';
import { InterpreterError } from '../../src/agent/interpreter.js';

describe('evaluation metrics', () => {
  it('includes the operation and normalizes goal set order', () => {
    expect(updateKey({ slot: 'goals', value: ['tax', 'company'] })).toBe(updateKey({ slot: 'goals', value: ['company', 'tax'], op: 'add' }));
    expect(updateKey({ slot: 'goals', value: ['company'], op: 'remove' })).not.toBe(updateKey({ slot: 'goals', value: ['company'], op: 'set' }));
  });
  it('counts a replacement instead of removal as both extraction and semantic error', () => {
    const profile = createEmptyProfile(); profile.slots.goals = { status: 'known', value: ['residence', 'company'] };
    const result = compareInterpretation({ intent: 'provide_info', updates: [{ slot: 'goals', value: ['company'], op: 'set' }], unsure: [] }, { intent: 'provide_info', updates: [{ slot: 'goals', value: ['company'], op: 'remove' }], unsure: [] }, profile);
    expect(result).toMatchObject({ intent: true, matched: 0, predicted: 1, expected: 1, semantic: false });
  });
  it('keeps failure denominators and reports skipped tags and categorized failures', async () => {
    const item: GoldenCase = { id: 'a', input: { profile: createEmptyProfile(), pendingSlots: [], text: 'text' }, expected: { intent: 'provide_info', updates: [{ slot: 'destination', value: 'PT' }], unsure: [] }, tags: ['rules'], reviewed: false };
    const result = await evaluate({ id: 'rules', interpret: async () => { throw new InterpreterError('invalid_output', 'bad'); } }, 'rules', [item, { ...item, id: 'b', tags: ['llm-only'] }], 1000);
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, expected: 1, failures: { invalid_output: 1 }, skipped: [{ id: 'b', reason: 'llm-only case' }] });
  });
});
