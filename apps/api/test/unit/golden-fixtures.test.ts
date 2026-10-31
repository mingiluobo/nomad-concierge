import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { interpretationSchema, profileSchema, slotKeySchema, slots } from '@nomad/shared';

const caseSchema = z.object({ id: z.string(), input: z.object({ profile: profileSchema, pendingSlots: z.array(slotKeySchema), text: z.string().min(1) }), expected: interpretationSchema, tags: z.array(z.string()), reviewed: z.boolean() });
const cases = z.array(caseSchema).parse(JSON.parse(readFileSync(new URL('../fixtures/golden-cases.json', import.meta.url), 'utf8')) as unknown);
describe('golden fixture integrity', () => {
  it('contains enough unique cases and separately reviewable key cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length);
    expect(cases.filter(item => item.tags.includes('key')).length).toBeGreaterThanOrEqual(10);
    expect(cases.every(item => item.tags.includes('rules') || item.tags.includes('llm-only'))).toBe(true);
  });
  it('uses valid expectation values and does not infer personal facts in the initial scenario', () => {
    for (const item of cases) for (const update of item.expected.updates) expect(slots[update.slot].valueSchema.safeParse(update.value).success, `${item.id}:${update.slot}`).toBe(true);
    const example = cases.find(item => item.id === 'G001')!;
    for (const slot of ['applicantNationality', 'currentResidence', 'residenceStatus', 'childrenCount']) expect(example.expected.updates.some(update => update.slot === slot)).toBe(false);
    expect(example.expected.updates).toContainEqual({ slot: 'destination', value: 'PT' });
    expect(cases.find(item => item.id === 'G013')?.expected.updates).toEqual([{ slot: 'goals', value: ['tax'], op: 'add' }]);
  });
});
