import { describe, expect, it } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import type { Profile } from '@nomad/shared';
import { RulesInterpreter } from '../../src/agent/rules/index.js';

async function interpret(text: string, profile: Profile = createEmptyProfile()) {
  return (await new RulesInterpreter().interpret({ profile, pendingSlots: profile.pendingSlots, recentMessages: [], newMessages: [{ id: 'ux-message', content: text }] }, new AbortController().signal)).interpretation;
}

describe('UX05 professional questions and country roles', () => {
  it.each(['我能拿到签证吗', '能不能拿到签证', '签证能否获批', '申请签证有没有资格', '申请签证符合条件吗', '签证申请得下来吗'])('recognizes %s and keeps the residence request', async text => {
    expect(await interpret(text)).toEqual({ intent: 'ask_professional', professionalTopic: 'visa_eligibility', updates: [{ slot: 'goals', value: ['residence'], op: 'add' }], unsure: [] });
  });
  it.each(['能否获批', '有没有资格', '符合条件吗', '申请得下来吗'])('uses the established visa context for %s', async text => {
    const profile = createEmptyProfile(); profile.slots.goals = { status: 'known', value: ['residence'] };
    expect(await interpret(text, profile)).toMatchObject({ intent: 'ask_professional', professionalTopic: 'visa_eligibility' });
  });
  it.each([
    ['我该缴多少税', 'tax_amount', 'tax'], ['我需要缴纳多少税款', 'tax_amount', 'tax'],
    ['我能注册公司吗', 'company_setup', 'company'], ['开公司需要什么资格', 'company_setup', 'company'],
  ])('recognizes %s without answering the professional question', async (text, professionalTopic, goal) => {
    expect(await interpret(text)).toEqual({ intent: 'ask_professional', professionalTopic, updates: [{ slot: 'goals', value: [goal], op: 'add' }], unsure: [] });
  });
  it('keeps applicant, partner, income and visa destination countries separate', async () => {
    const result = await interpret('我是中国籍，配偶是德国籍，收入来自美国，有资格申请葡萄牙签证吗？');
    expect(result).toMatchObject({ intent: 'ask_professional', professionalTopic: 'visa_eligibility' });
    expect(result.updates).toEqual(expect.arrayContaining([
      { slot: 'applicantNationality', value: 'CN' }, { slot: 'partnerNationality', value: 'DE' },
      { slot: 'incomeCountry', value: 'US' }, { slot: 'destination', value: 'PT' },
      { slot: 'goals', value: ['residence'], op: 'add' },
    ]));
    expect(result.updates).toHaveLength(5);
  });
  it('assigns a visa country without swallowing a nationality later in the same clause', async () => {
    const result = await interpret('申请葡萄牙签证的我是中国籍');
    expect(result.updates).toContainEqual({ slot: 'destination', value: 'PT' });
    expect(result.updates).toContainEqual({ slot: 'applicantNationality', value: 'CN' });
  });
  it('keeps ordinary intentions informational and unrelated application questions off-topic', async () => {
    expect(await interpret('我想申请签证')).toEqual({ intent: 'provide_info', updates: [{ slot: 'goals', value: ['residence'], op: 'add' }], unsure: [] });
    expect(await interpret('我可以申请信用卡吗')).toEqual({ intent: 'off_topic', updates: [], unsure: [] });
  });
});

describe('UX04 requested scope and background facts', () => {
  it.each(['只想了解税务，已经有医疗保险', '已经有医疗保险，只想了解税务', '只想了解税务而且已经有医疗保险'])('keeps the requested scope in %s', async text => {
    const result = await interpret(text);
    expect(result.intent).toBe('provide_info');
    expect(result.updates.filter(update => update.slot === 'goals')).toEqual([{ slot: 'goals', value: ['tax'], op: 'set' }]);
    expect(result.updates).toContainEqual({ slot: 'hasHealthInsurance', value: true });
  });
  it.each([
    ['已经有医疗保险', 'hasHealthInsurance', true], ['没有医疗保险', 'hasHealthInsurance', false],
    ['公司主要做软件', 'businessType', 'software'], ['孩子想上公立学校', 'schoolPreference', 'public'],
    ['我是自由职业者', 'incomeSource', 'freelancer'], ['自己做生意', 'incomeSource', 'business_owner'],
  ])('records %s as a fact without adding a goal', async (text, slot, value) => {
    expect(await interpret(text)).toEqual({ intent: 'provide_info', updates: [{ slot, value }], unsure: [] });
  });
  it.each(['想了解医疗保险', '想咨询孩子上公立学校的事情', '想了解开软件公司的流程'])('keeps an explicit request in %s', async text => {
    const result = await interpret(text);
    const goal = text.includes('医疗') ? 'healthcare' : text.includes('学校') ? 'education' : 'company';
    expect(result.updates).toContainEqual({ slot: 'goals', value: [goal], op: 'add' });
  });
});

describe('UX03 relative departure times', () => {
  it.each([
    ['下周出发', 'lt3m'], ['本月出发', 'lt3m'], ['一个月后出发', 'lt3m'], ['两个月后出发', 'lt3m'],
    ['三个月内出发', 'lt3m'], ['计划三个月后出发', '3to6m'], ['4个月后出发', '3to6m'],
    ['半年内出发', '3to6m'], ['计划半年后出发', '6to12m'], ['六个月后出发', '6to12m'],
    ['九个月后出发', '6to12m'], ['明年出发', '6to12m'], ['一年后出发', 'gt12m'],
  ])('maps %s to the fixed interval %s', async (text, value) => {
    expect(await interpret(text)).toEqual({ intent: 'provide_info', updates: [{ slot: 'timeline', value }], unsure: [] });
  });
  it.each(['等事情处理完再出发', '出发时间要再商量', '年底出发'])('keeps an unparsed planning time relevant: %s', async text => {
    expect(await interpret(text)).toEqual({ intent: 'provide_info', updates: [], unsure: [] });
  });
});
