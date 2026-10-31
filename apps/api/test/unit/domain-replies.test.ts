import { describe, expect, it } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import type { Interpretation, Profile, SlotKey } from '@nomad/shared';
import type { MergeResult } from '../../src/composition.js';
import { composeReply, renderReplyText } from '../../src/domain/replies.js';
import { mergeInterpretation, progress, reconcile } from '../../src/domain/profile.js';
import { nextQuestions } from '../../src/domain/policy.js';
import { professionalConditions } from '../../src/domain/professional.js';
import { generateTitle } from '../../src/domain/title.js';
import { canTransition, transition } from '../../src/domain/stateMachine.js';

const now = '2026-10-31T03:00:00.000Z';
function profile(values: Partial<Record<SlotKey, unknown>> = {}): Profile {
  const result = createEmptyProfile();
  for (const [key, value] of Object.entries(values)) result.slots[key as SlotKey] = { status: 'known', value };
  return result;
}
function reply(interpretation: Interpretation | null, input = profile(), destinationChanged = false, mergeResult?: MergeResult) {
  const result = mergeResult ?? mergeInterpretation(input, interpretation ?? { intent: 'provide_info', updates: [], unsure: [] }, 'm', now);
  return composeReply({ mergeResult: result, interpretation, progress: progress(result.profile), nextQuestions: nextQuestions(result.profile), destinationChanged });
}

describe('professional conditions and replies', () => {
  it('builds topic-specific known and unknown conditions with fixed professional checks', () => {
    const input = profile({ hasPartner: false, applicantNationality: 'CN', incomeSource: 'freelancer', goals: ['tax'] });
    expect(professionalConditions('visa_eligibility', input).map(item => item.label)).toEqual(['本人国籍', '主要收入来源', '计划时间', '收入证明、无犯罪记录、住所等材料要求']);
    expect(professionalConditions('tax_amount', input)).toContainEqual({ slot: 'incomeSource', label: '主要收入来源', known: true, display: '自由职业' });
    expect(professionalConditions('company_setup', input)[0]).toEqual({ slot: 'businessType', label: '公司业务类型', known: false, display: '待了解' });
    expect(professionalConditions('other', input).map(item => item.slot)).toEqual(['destination', 'goals']);
  });
  it('explains professional limits and continues asking for missing information', () => {
    const payload = reply({ intent: 'ask_professional', professionalTopic: 'visa_eligibility', updates: [{ slot: 'applicantNationality', value: 'CN' }], unsure: [] });
    expect(payload.notices[0]?.kind).toBe('professional');
    expect(payload.notices[0]?.conditions).toContainEqual(expect.objectContaining({ label: '本人国籍', display: '中国', known: true }));
    expect(renderReplyText(payload)).toContain('没办法给出结论');
    expect(renderReplyText(payload)).toContain('需要持牌专业人士确认');
    expect(payload.questions.map(question => question.slot)).toEqual(['destination', 'goals']);
  });
  it('distinguishes off-topic guidance from relevant but unrecognized input and quick-only replies', () => {
    expect(reply({ intent: 'off_topic', updates: [], unsure: [] }).notices.map(notice => notice.kind)).toEqual(['off_topic']);
    expect(reply({ intent: 'provide_info', updates: [], unsure: [] }).notices.map(notice => notice.kind)).toEqual(['not_understood']);
    expect(reply(null).notices).toEqual([]);
  });
  it('announces uncovered countries only on destination changes', () => {
    const input = profile({ destination: 'CL' });
    expect(reply(null, input, true).notices).toContainEqual({ kind: 'unsupported_destination', text: '目前只有葡萄牙的详细资料，智利会给出通用的准备清单。' });
    expect(reply(null, input, false).notices).toEqual([]);
  });
  it('shows readiness after every required field is answered, including unsure', () => {
    const input = profile({ destination: 'PT', goals: ['tax'], applicantNationality: 'CN', hasPartner: false, childrenCount: 0, currentResidence: 'CN', residenceStatus: 'citizen', timeline: 'lt3m', incomeCountry: 'CN' });
    input.slots.timeline = { status: 'unsure' };
    const payload = reply(null, input);
    expect(payload.questions).toEqual([]);
    expect(payload.notices.map(notice => notice.kind)).toEqual(['ready']);
  });
  it('renders ordinary corrections and automatic invalidation reasons without changing business correction metadata', () => {
    const input = profile({ partnerNationality: 'CN', childrenCount: 1, childrenAges: [6], currentResidence: 'CN', residenceStatus: 'citizen' });
    const interpretation: Interpretation = { intent: 'provide_info', updates: [{ slot: 'partnerNationality', value: 'PT' }, { slot: 'childrenCount', value: 2 }, { slot: 'currentResidence', value: 'PT' }], unsure: [] };
    const merged = mergeInterpretation(input, interpretation, 'm', now);
    const reconciled = reconcile(input, merged.profile, merged.providedSlots);
    const combined = { ...merged, profile: reconciled.profile, invalidated: reconciled.invalidated };
    const payload = reply(interpretation, input, false, combined);
    expect(renderReplyText(payload)).toContain('已更新：配偶国籍 中国 → 葡萄牙');
    expect(renderReplyText(payload)).toContain('孩子人数变了，孩子年龄需要重新确认');
    expect(renderReplyText(payload)).toContain('当前居住国变了，在当前居住国的身份需要重新确认');
    expect(combined.corrected.map(item => item.slot)).toEqual(['partnerNationality', 'childrenCount', 'currentResidence']);
    expect(combined.profile.slots.childrenAges).toEqual({ status: 'missing', previousValue: [6] });
    expect(payload.corrections).toContainEqual({ slot: 'childrenAges', label: '孩子年龄', from: '6 岁', to: '待了解' });
    expect(combined.providedSlots).toEqual(['partnerNationality', 'childrenCount', 'currentResidence']);
  });
  it('builds titles from known facts without guessing a solo household', () => {
    expect(generateTitle(profile())).toBe('新的出海咨询');
    expect(generateTitle(profile({ destination: 'PT' }))).toBe('葡萄牙 · 家庭情况待了解');
    expect(generateTitle(profile({ destination: 'PT', hasPartner: false, childrenCount: 0 }))).toBe('葡萄牙 · 个人');
    expect(generateTitle(profile({ destination: 'PT', childrenCount: 1 }))).toBe('葡萄牙 · 全家');
  });
});

describe('state transitions', () => {
  const legal = [['collecting', 'completed'], ['queued', 'running'], ['queued', 'cancelled'], ['queued', 'superseded'], ['running', 'completed'], ['running', 'failed'], ['running', 'cancelled'], ['running', 'superseded'], ['running', 'queued']] as const;
  it.each(legal)('allows %s to %s and generates a versioned conditional update', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition(from, to)).toEqual({ setSql: 'status = ?, version = version + 1', setParameters: [to], whereSql: 'status IN (?)', whereParameters: [from] });
  });
  it.each([['completed', 'running'], ['failed', 'queued'], ['cancelled', 'running'], ['superseded', 'completed'], ['collecting', 'running'], ['queued', 'failed'], ['running', 'running']] as const)('rejects %s to %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transition(from, to)).toThrow(expect.objectContaining({ code: 'ILLEGAL_TRANSITION', status: 409 }));
  });
});
