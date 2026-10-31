import { describe, expect, it } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import type { SlotKey } from '@nomad/shared';
import { RulesInterpreter } from '../../src/agent/rules/index.js';

const interpret = (text: string, pendingSlots: SlotKey[] = []) => new RulesInterpreter().interpret({
  profile: createEmptyProfile(), pendingSlots, recentMessages: [], newMessages: [{ id: 'answer', content: text }],
}, new AbortController().signal);
const unassignedAnswers = ['2', '12', '2.5', '嗯', '好', '行', '好的', '说', '做', '二', '两个', '啊'];

describe('unassigned short answers to pending questions', () => {
  describe.each([
    ['one pending question', ['timeline']],
    ['multiple pending questions', ['timeline', 'incomeSource']],
  ] as [string, SlotKey[]][])('%s', (_context, pendingSlots) => {
    it.each(unassignedAnswers)('keeps %s relevant without guessing a slot', async text => {
      expect((await interpret(text, pendingSlots)).interpretation).toEqual({ intent: 'provide_info', updates: [], unsure: [] });
    });
  });
  it.each(unassignedAnswers)('does not infer relevance for %s without a pending question', async text => {
    expect((await interpret(text)).interpretation).toEqual({ intent: 'off_topic', updates: [], unsure: [] });
  });
  it.each(['今天午饭吃什么', '吃啥', '唱歌', '讲笑话', '天气？', '谁', '好吗', '帮我', '写诗', '画画', '2？', '来点'])('keeps the unrelated question or request %s off-topic', async text => {
    expect((await interpret(text, ['timeline', 'incomeSource'])).interpretation).toEqual({ intent: 'off_topic', updates: [], unsure: [] });
  });
  it('preserves an existing numeric answer extraction for the pending child count', async () => {
    expect((await interpret('2', ['childrenCount'])).interpretation).toEqual({
      intent: 'provide_info', updates: [{ slot: 'childrenCount', value: 2 }], unsure: [],
    });
  });
  it('preserves an existing one-character boolean answer extraction', async () => {
    expect((await interpret('有', ['hasPartner'])).interpretation).toEqual({
      intent: 'provide_info', updates: [{ slot: 'hasPartner', value: true }], unsure: [],
    });
  });
  it('keeps a short professional topic ahead of the short-answer fallback', async () => {
    expect((await interpret('税率', ['timeline', 'incomeSource'])).interpretation).toEqual({
      intent: 'ask_professional', professionalTopic: 'tax_amount', updates: [{ slot: 'goals', value: ['tax'], op: 'add' }], unsure: [],
    });
  });
  it('keeps professional intent when another message is an unassigned short answer', async () => {
    const result = await new RulesInterpreter().interpret({
      profile: createEmptyProfile(), pendingSlots: ['timeline', 'incomeSource'], recentMessages: [],
      newMessages: [{ id: 'answer', content: '嗯' }, { id: 'question', content: '能不能申请？' }],
    }, new AbortController().signal);
    expect(result.interpretation).toEqual({ intent: 'ask_professional', professionalTopic: 'visa_eligibility', updates: [], unsure: [] });
  });
});
