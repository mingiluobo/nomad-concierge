import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import type { Interpretation, Profile, SlotKey } from '@nomad/shared';
import { RulesInterpreter } from '../../src/agent/rules/index.js';
import { chineseNumber } from '../../src/agent/rules/numbers.js';

const cases = JSON.parse(readFileSync(new URL('../fixtures/golden-cases.json', import.meta.url), 'utf8')) as { id: string; input: { profile: Profile; pendingSlots: SlotKey[]; text: string }; expected: Interpretation; tags: string[] }[];
const engine = new RulesInterpreter();
const normalize = (result: Interpretation) => ({ ...result, unsure: [...result.unsure].sort(), updates: result.updates.map(update => ({ ...update, op: update.op ?? (update.slot === 'goals' ? 'add' : 'set'), value: update.slot === 'goals' ? [...update.value as string[]].sort() : update.value })).sort((a, b) => a.slot.localeCompare(b.slot)) });
const interpret = (text: string, pendingSlots: SlotKey[] = []) => engine.interpret({ profile: createEmptyProfile(), pendingSlots, recentMessages: [], newMessages: [{ id: 'm', content: text }] }, new AbortController().signal);
const uncertaintyExpressions = ['不知道', '不确定', '还没想好', '没想好', '看情况', '跳过', '不清楚'];

describe('rule interpreter', () => {
  it.each(cases.filter(item => item.tags.includes('rules')))('$id follows the independently authored expected interpretation', async item => {
    const result = await engine.interpret({ ...item.input, recentMessages: [], newMessages: [{ id: 'm', content: item.input.text }] }, new AbortController().signal);
    expect(normalize(result.interpretation)).toEqual(normalize(item.expected));
    expect(result.engineUsed).toBe('rules');
    expect(result.fallbacks).toEqual([]);
  });
  it('keeps corrections in chronological message order', async () => {
    const result = await engine.interpret({ profile: createEmptyProfile(), pendingSlots: [], recentMessages: [], newMessages: [{ id: '1', content: '配偶是中国籍' }, { id: '2', content: '不对，配偶是葡萄牙籍' }] }, new AbortController().signal);
    expect(result.interpretation.updates).toEqual([{ slot: 'partnerNationality', value: 'CN' }, { slot: 'partnerNationality', value: 'PT' }]);
  });
  it('does not copy profile or recent context into new output', async () => {
    const profile = createEmptyProfile(); profile.slots.applicantNationality = { status: 'known', value: 'CN' };
    const result = await engine.interpret({ profile, pendingSlots: [], recentMessages: [{ role: 'user', content: '我住中国' }], newMessages: [{ id: 'm', content: '下个月' }] }, new AbortController().signal);
    expect(result.interpretation.updates).toEqual([{ slot: 'timeline', value: 'lt3m' }]);
  });
  it('handles unfamiliar phrasing using lexical context rather than whole-input matches', async () => {
    expect((await interpret('我和妻子准备前往西班牙生活，想了解税务')).interpretation.updates).toEqual(expect.arrayContaining([{ slot: 'destination', value: 'ES' }, { slot: 'hasPartner', value: true }, { slot: 'goals', value: ['residence', 'tax'], op: 'add' }]));
    expect((await interpret('不需要医疗，也不开公司')).interpretation.updates).toEqual([{ slot: 'goals', value: ['healthcare', 'company'], op: 'remove' }]);
  });
  it('does not infer a nationality from a country mentioned as destination or current home', async () => {
    const result = await interpret('目前在德国，打算搬到葡萄牙生活');
    expect(result.interpretation.updates).toEqual(expect.arrayContaining([{ slot: 'currentResidence', value: 'DE' }, { slot: 'destination', value: 'PT' }]));
    expect(result.interpretation.updates.some(update => update.slot === 'applicantNationality')).toBe(false);
  });
  it('assigns each country using its local context within a clause', async () => {
    const result = await interpret('配偶是中国籍我是德国人目前住在西班牙准备搬到葡萄牙');
    expect(result.interpretation.updates).toEqual(expect.arrayContaining([
      { slot: 'partnerNationality', value: 'CN' }, { slot: 'applicantNationality', value: 'DE' },
      { slot: 'currentResidence', value: 'ES' }, { slot: 'destination', value: 'PT' },
    ]));
  });
  it('recognizes paired ages without inferring a count from an unnumbered child reference', async () => {
    expect((await interpret('一个6岁一个9岁')).interpretation.updates).toEqual([{ slot: 'childrenAges', value: [6, 9] }, { slot: 'childrenCount', value: 2 }]);
    expect((await interpret('带孩子')).interpretation.updates).toEqual([]);
  });
  it('uses the last enum correction while preserving negative insurance phrases', async () => {
    expect((await interpret('下个月改成明年')).interpretation.updates).toEqual([{ slot: 'timeline', value: '6to12m' }]);
    expect((await interpret('没有保险')).interpretation.updates).toEqual([{ slot: 'hasHealthInsurance', value: false }]);
    expect((await interpret('没有保险后来有保险')).interpretation.updates).toEqual([{ slot: 'hasHealthInsurance', value: true }]);
  });
  it('keeps explicit replacements as separate ordered operations', async () => {
    expect((await interpret('只想开公司，改成医疗')).interpretation.updates).toEqual([{ slot: 'goals', value: ['company'], op: 'set' }, { slot: 'goals', value: ['healthcare'], op: 'set' }]);
  });
  it('rejects out-of-range extracted values and respects an external abort', async () => {
    const invalidCount = await interpret('十二个孩子');
    expect(invalidCount.interpretation.updates).toEqual([]);
    expect(invalidCount.droppedUpdates).toEqual([{ slot: 'childrenCount', reason: 'Invalid slot value' }]);
    await expect(engine.interpret({ profile: createEmptyProfile(), pendingSlots: [], recentMessages: [], newMessages: [] }, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('records ignored unsure answers for slots that forbid uncertainty', async () => {
    const result = await interpret('目的地不知道');
    expect(result.interpretation.unsure).toEqual([]);
    expect(result.droppedUpdates).toEqual([{ slot: 'destination', reason: 'This slot does not allow unsure' }]);
  });
  describe.each([
    { context: 'no pending slot', pendingSlots: [] as SlotKey[], unsure: [] as SlotKey[] },
    { context: 'multiple pending slots', pendingSlots: ['timeline', 'incomeSource'] as SlotKey[], unsure: [] as SlotKey[] },
    { context: 'one slot forbidding uncertainty', pendingSlots: ['applicantNationality'] as SlotKey[], unsure: [] as SlotKey[] },
    { context: 'one slot allowing uncertainty', pendingSlots: ['timeline'] as SlotKey[], unsure: ['timeline'] as SlotKey[] },
  ])('uncertainty with $context', ({ pendingSlots, unsure }) => {
    it.each(uncertaintyExpressions)('keeps %s relevant without inventing a slot value', async text => {
      expect((await interpret(text, pendingSlots)).interpretation).toEqual({ intent: 'provide_info', updates: [], unsure });
    });
  });
  it.each([
    { text: '时间不清楚', unsure: ['timeline'] },
    { text: '都不知道', unsure: ['timeline', 'incomeSource'] },
    { text: '都不确定', unsure: ['timeline', 'incomeSource'] },
    { text: '都没想好', unsure: ['timeline', 'incomeSource'] },
  ])('preserves explicit uncertainty targeting for $text', async ({ text, unsure }) => {
    expect((await interpret(text, ['timeline', 'incomeSource'])).interpretation).toEqual({ intent: 'provide_info', updates: [], unsure });
  });
  it('gives professional questions priority over uncertainty while preserving extracted information', async () => {
    expect((await interpret('时间不知道，我是自由职业者，能不能申请？', ['timeline', 'incomeSource'])).interpretation).toEqual({
      intent: 'ask_professional', professionalTopic: 'visa_eligibility', updates: [{ slot: 'incomeSource', value: 'freelancer' }], unsure: ['timeline'],
    });
  });
  it.each(['我能申请哪个签证', '可以申请哪种签证'])('recognizes the visa eligibility question %s while retaining the residence goal', async text => {
    expect((await interpret(text)).interpretation).toEqual({
      intent: 'ask_professional', professionalTopic: 'visa_eligibility', updates: [{ slot: 'goals', value: ['residence'], op: 'add' }], unsure: [],
    });
  });
  it('keeps an ordinary visa statement informational and unrelated content off-topic', async () => {
    expect((await interpret('我想申请签证')).interpretation).toEqual({ intent: 'provide_info', updates: [{ slot: 'goals', value: ['residence'], op: 'add' }], unsure: [] });
    expect((await interpret('今天天气怎么样')).interpretation).toEqual({ intent: 'off_topic', updates: [], unsure: [] });
  });
  it.each([['零', 0], ['两', 2], ['十', 10], ['二十五', 25], ['9', 9], ['abc', null]] as const)('parses number %s', (input, value) => expect(chineseNumber(input)).toBe(value));
});
