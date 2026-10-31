import { describe, expect, it } from 'vitest';
import {
  countries, countryCodeSchema, createEmptyProfile, interpretationSchema, messageDtoSchema,
  postMessageRequestSchema, profileSchema, slotDefinitions, slotOptions, slots, turnTransitions,
  serverMessageSchema, loginRequestSchema, messagesQuerySchema,
} from './index.js';

describe('shared contract', () => {
  it('starts with every slot missing and accepts the complete empty profile', () => {
    const profile = createEmptyProfile();
    expect(profileSchema.parse(profile)).toEqual(profile);
    expect(Object.keys(profile.slots)).toHaveLength(15);
    expect(Object.values(profile.slots).every(slot => slot.status === 'missing')).toBe(true);
    expect(profile.slots.applicantNationality.value).toBeUndefined();
    expect(profileSchema.safeParse({ slots: {}, pendingSlots: [] }).success).toBe(false);
  });

  it('uses unique priorities and distinguishes conditional requiredness', () => {
    expect(slotDefinitions.map(slot => slot.priority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const profile = createEmptyProfile();
    expect(slots.partnerNationality.requiredWhen(profile)).toBe(false);
    expect(slots.schoolPreference.requiredWhen(profile)).toBe(false);
    profile.slots.hasPartner = { status: 'known', value: true };
    profile.slots.goals = { status: 'known', value: ['education'] };
    profile.slots.childrenCount = { status: 'known', value: 2 };
    expect(slots.partnerNationality.requiredWhen(profile)).toBe(true);
    expect(slots.schoolPreference.requiredWhen(profile)).toBe(true);
    expect(slots.incomeSource.requiredWhen(profile)).toBe(false);
    expect(slots.destination.inputLabels).toEqual(['其他（请输入）']);
    expect(slots.applicantNationality.inputLabels).toEqual(['其他欧盟国家（请输入）', '其他（请输入）']);
    expect(slots.childrenCount.inputLabels).toEqual(['3 个及以上（请输入）']);
  });

  it.each([
    ['destination', 'PT', 'ZZ'], ['goals', ['residence'], []], ['applicantNationality', 'CN', 'Chinese'],
    ['hasPartner', false, 'false'], ['partnerNationality', 'PT', 123], ['childrenCount', 2, 2.5],
    ['childrenAges', [6, 9], [-1]], ['currentResidence', 'CN', 'cn'], ['residenceStatus', 'citizen', 'resident'],
    ['timeline', 'lt3m', 'tomorrow'], ['incomeSource', 'freelancer', 'salary'], ['businessType', 'software', 'mining'],
    ['incomeCountry', 'US', 'XX'], ['schoolPreference', 'public', 'private'], ['hasHealthInsurance', true, 1],
  ] as const)('validates legal and illegal values for %s', (key, valid, invalid) => {
    expect(slots[key].valueSchema.safeParse(valid).success).toBe(true);
    expect(slots[key].valueSchema.safeParse(invalid).success).toBe(false);
  });

  it('covers every requiredWhen condition without inferring missing parent values', () => {
    const profile = createEmptyProfile();
    const alwaysRequired = ['destination', 'goals', 'applicantNationality', 'hasPartner', 'childrenCount', 'currentResidence', 'residenceStatus', 'timeline'] as const;
    const conditional = ['partnerNationality', 'childrenAges', 'incomeSource', 'businessType', 'incomeCountry', 'schoolPreference', 'hasHealthInsurance'] as const;
    for (const key of alwaysRequired) expect(slots[key].requiredWhen(profile)).toBe(true);
    for (const key of conditional) expect(slots[key].requiredWhen(profile)).toBe(false);
    profile.slots.hasPartner = { status: 'known', value: false };
    profile.slots.childrenCount = { status: 'known', value: 0 };
    profile.slots.goals = { status: 'known', value: ['residence', 'company', 'tax', 'education', 'healthcare'] };
    expect(slots.partnerNationality.requiredWhen(profile)).toBe(false);
    expect(slots.childrenAges.requiredWhen(profile)).toBe(false);
    expect(slots.schoolPreference.requiredWhen(profile)).toBe(false);
    for (const key of ['incomeSource', 'businessType', 'incomeCountry', 'hasHealthInsurance'] as const) expect(slots[key].requiredWhen(profile)).toBe(true);
    profile.slots.hasPartner = { status: 'known', value: true };
    profile.slots.childrenCount = { status: 'known', value: 1 };
    for (const key of conditional) expect(slots[key].requiredWhen(profile)).toBe(true);
    profile.slots.goals = { status: 'known', value: ['tax'] };
    expect(slots.incomeCountry.requiredWhen(profile)).toBe(true);
    for (const key of ['incomeSource', 'businessType', 'schoolPreference', 'hasHealthInsurance'] as const) expect(slots[key].requiredWhen(profile)).toBe(false);
  });

  it('validates slot values independently of interpretation structure', () => {
    expect(slots.childrenCount.valueSchema.safeParse(11).success).toBe(false);
    expect(slots.childrenAges.valueSchema.safeParse([6, 26]).success).toBe(false);
    expect(slots.goals.valueSchema.safeParse([]).success).toBe(false);
    expect(countryCodeSchema.safeParse('ZZ').success).toBe(false);
    expect(countryCodeSchema.parse('CL')).toBe('CL');
    expect(countries.find(country => country.code === 'CL')?.aliases).toContain('智利');
    const result = interpretationSchema.parse({ intent: 'provide_info', updates: [{ slot: 'childrenCount', value: 90 }], unsure: [] });
    expect(result.updates[0]?.value).toBe(90);
  });

  it('enforces professional and off-topic intent structure', () => {
    expect(interpretationSchema.safeParse({ intent: 'ask_professional', updates: [], unsure: [] }).success).toBe(false);
    expect(interpretationSchema.safeParse({ intent: 'off_topic', updates: [{ slot: 'destination', value: 'PT' }], unsure: [] }).success).toBe(false);
    expect(interpretationSchema.safeParse({ intent: 'provide_info', updates: [{ slot: 'destination' }], unsure: [] }).success).toBe(false);
  });

  it('adds only applicable dynamic quick choices and preserves unsure for domain handling', () => {
    const profile = createEmptyProfile();
    expect(slotOptions('destination', profile)).toEqual([{ label: '葡萄牙', value: 'PT' }]);
    profile.slots.applicantNationality = { status: 'known', value: 'CN' };
    expect(slotOptions('partnerNationality', profile)).toEqual([{ label: '同本人国籍', value: 'CN' }, { label: '不确定', value: { unsure: true } }]);
    expect(postMessageRequestSchema.safeParse({ content: '', clientMessageId: 'a', payload: { answers: [{ slot: 'destination', value: { unsure: true }, label: '不确定' }] } }).success).toBe(true);
    expect(postMessageRequestSchema.safeParse({ content: ' ', clientMessageId: 'b' }).success).toBe(false);
  });

  it('does not accept malformed assistant payload as an empty user payload', () => {
    const base = { id: 'm', conversationId: 'c', seq: 1, content: 'hello', clientMessageId: null, turnId: 't', createdAt: '2026-10-31T00:00:00.000Z' };
    expect(messageDtoSchema.safeParse({ ...base, role: 'assistant', payload: { answers: [] } }).success).toBe(false);
    expect(messageDtoSchema.safeParse({ ...base, role: 'user', payload: { nonsense: true } }).success).toBe(false);
    expect(messageDtoSchema.safeParse({ ...base, role: 'user', payload: null }).success).toBe(true);
  });

  it('keeps terminal states closed and identity present on ready frames', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'superseded'] as const) expect(turnTransitions[status]).toEqual([]);
    expect(turnTransitions.running).toContain('queued');
    expect(serverMessageSchema.safeParse({ type: 'ready', latestEventId: 0 }).success).toBe(false);
    expect(serverMessageSchema.parse({ type: 'ready', latestEventId: 0, userId: 'u' })).toEqual({ type: 'ready', latestEventId: 0, userId: 'u' });
  });

  it('normalizes login whitespace and validates pagination bounds', () => {
    expect(loginRequestSchema.parse({ username: '  Alice  ' })).toEqual({ username: 'Alice' });
    expect(loginRequestSchema.safeParse({ username: ' a ' }).success).toBe(false);
    expect(messagesQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(messagesQuerySchema.parse({ before: '5', limit: '10' })).toEqual({ before: 5, limit: 10 });
    expect(messagesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});
