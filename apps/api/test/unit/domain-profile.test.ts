import { describe, expect, it } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import type { Interpretation, Profile, SlotKey, SlotUpdate } from '@nomad/shared';
import { applicability, canGenerateEarly, isComplete, mergeInterpretation, progress, reconcile, requiredSlots } from '../../src/domain/profile.js';
import { nextQuestions } from '../../src/domain/policy.js';

const now = '2026-10-31T01:00:00.000Z';
function profile(values: Partial<Record<SlotKey, unknown>> = {}): Profile {
  const result = createEmptyProfile();
  for (const [key, value] of Object.entries(values)) result.slots[key as SlotKey] = { status: 'known', value };
  return result;
}
const info = (updates: SlotUpdate[] = [], unsure: SlotKey[] = []): Interpretation => ({ intent: 'provide_info', updates, unsure });
const full = () => profile({ destination: 'PT', goals: ['residence'], applicantNationality: 'CN', hasPartner: false, childrenCount: 0, currentResidence: 'CN', residenceStatus: 'citizen', timeline: '6to12m', incomeSource: 'freelancer' });

describe('profile merging', () => {
  it('records values and provenance without mutating the input', () => {
    const before = profile();
    const result = mergeInterpretation(before, info([{ slot: 'destination', value: 'PT' }]), 'm1', now);
    expect(before.slots.destination).toEqual({ status: 'missing' });
    expect(result.profile.slots.destination).toEqual({ status: 'known', value: 'PT', sourceMessageId: 'm1', updatedAt: now });
    expect(result.recorded).toEqual(['destination']);
    expect(result.providedSlots).toEqual(['destination']);
  });
  it('replaces unsure with known and records only the immediately previous corrected value', () => {
    const before = profile(); before.slots.timeline = { status: 'unsure' };
    const first = mergeInterpretation(before, info([{ slot: 'timeline', value: '6to12m' }]), 'm1', now);
    expect(first.recorded).toEqual(['timeline']);
    expect(first.profile.slots.timeline.corrected).toBeUndefined();
    const second = mergeInterpretation(first.profile, info([{ slot: 'timeline', value: 'lt3m' }]), 'm2', now);
    const third = mergeInterpretation(second.profile, info([{ slot: 'timeline', value: 'gt12m' }]), 'm3', now);
    expect(third.profile.slots.timeline).toMatchObject({ status: 'known', value: 'gt12m', previousValue: 'lt3m', corrected: true, sourceMessageId: 'm3' });
    expect(third.corrected).toEqual([{ slot: 'timeline', from: 'lt3m', to: 'gt12m' }]);
  });
  it('keeps same-value state exactly but tracks the explicit input for reconciliation', () => {
    const before = profile({ residenceStatus: 'citizen' });
    before.slots.residenceStatus.sourceMessageId = 'old';
    const result = mergeInterpretation(before, info([{ slot: 'residenceStatus', value: 'citizen' }]), 'new', now);
    expect(result.profile.slots.residenceStatus).toEqual(before.slots.residenceStatus);
    expect(result.recorded).toEqual([]); expect(result.corrected).toEqual([]);
    expect(result.providedSlots).toEqual(['residenceStatus']);
  });
  it('records unsure only where allowed and never overwrites a known answer', () => {
    const before = profile({ incomeSource: 'freelancer' });
    const result = mergeInterpretation(before, info([], ['timeline', 'incomeSource', 'destination', 'applicantNationality', 'hasPartner', 'childrenCount', 'currentResidence', 'goals']), 'm', now);
    expect(result.profile.slots.timeline).toEqual({ status: 'unsure', sourceMessageId: 'm', updatedAt: now });
    expect(result.profile.slots.incomeSource).toEqual(before.slots.incomeSource);
    expect(result.recorded).toEqual(['timeline']); expect(result.providedSlots).toEqual([]);
    expect(result.droppedUpdates.map(update => update.slot)).toEqual(['destination', 'applicantNationality', 'hasPartner', 'childrenCount', 'currentResidence', 'goals']);
    for (const slot of ['destination', 'applicantNationality', 'hasPartner', 'childrenCount', 'currentResidence', 'goals'] as const) expect(result.profile.slots[slot].status).toBe('missing');
  });
  it('adds goals as a set without turning additions into corrections', () => {
    const result = mergeInterpretation(profile({ goals: ['residence', 'company'] }), info([{ slot: 'goals', value: ['tax', 'company', 'tax'] }]), 'm', now);
    expect(result.profile.slots.goals.value).toEqual(['residence', 'company', 'tax']);
    expect(result.recorded).toEqual(['goals']); expect(result.corrected).toEqual([]);
    expect(result.profile.slots.goals.corrected).toBeUndefined();
  });
  it('removes or replaces goals explicitly and ignores removal of the entire set', () => {
    const before = profile({ goals: ['residence', 'company'] });
    const removed = mergeInterpretation(before, info([{ slot: 'goals', value: ['company'], op: 'remove' }]), 'm', now);
    expect(removed.corrected).toEqual([{ slot: 'goals', from: ['residence', 'company'], to: ['residence'] }]);
    expect(removed.recorded).toEqual([]);
    expect(mergeInterpretation(removed.profile, info([{ slot: 'goals', value: ['residence'], op: 'remove' }]), 'm2', now).profile).toEqual(removed.profile);
    const replaced = mergeInterpretation(before, info([{ slot: 'goals', value: ['tax'], op: 'set' }]), 'm3', now);
    expect(replaced.profile.slots.goals).toMatchObject({ value: ['tax'], previousValue: ['residence', 'company'], corrected: true });
    expect(mergeInterpretation(before, info([{ slot: 'goals', value: ['company', 'residence'], op: 'set' }]), 'm4', now).corrected).toEqual([]);
  });
  it('drops illegal values and operations while preserving independent valid updates', () => {
    const result = mergeInterpretation(profile(), info([
      { slot: 'childrenCount', value: 20 }, { slot: 'timeline', value: 'lt3m', op: 'remove' },
      { slot: 'destination', value: 'MARS' }, { slot: 'incomeSource', value: 'freelancer' },
    ]), 'm', now);
    expect(result.droppedUpdates.map(update => update.slot)).toEqual(['childrenCount', 'timeline', 'destination']);
    expect(result.profile.slots.incomeSource.value).toBe('freelancer');
    expect(result.providedSlots).toEqual(['incomeSource']);
  });
  it('keeps input order, explicit source ids and unmentioned slots across text and quick-answer segments', () => {
    const initial = profile({ applicantNationality: 'PT', currentResidence: 'CN' });
    const first = mergeInterpretation(initial, info([{ slot: 'partnerNationality', value: 'CN' }]), 'text-1', now);
    const second = mergeInterpretation(first.profile, info([{ slot: 'partnerNationality', value: 'PT' }]), 'quick-2', now);
    const third = mergeInterpretation(second.profile, info([{ slot: 'timeline', value: '6to12m' }]), 'text-3', now);
    expect(third.profile.slots.partnerNationality).toMatchObject({ value: 'PT', sourceMessageId: 'quick-2', previousValue: 'CN' });
    expect(third.profile.slots.timeline).toMatchObject({ value: '6to12m', sourceMessageId: 'text-3' });
    expect(third.profile.slots.currentResidence).toEqual(initial.slots.currentResidence);
    const reverse = mergeInterpretation(second.profile, info([{ slot: 'partnerNationality', value: 'CN' }]), 'text-4', now);
    expect(reverse.profile.slots.partnerNationality).toMatchObject({ value: 'CN', sourceMessageId: 'text-4' });
  });
});

describe('consistency and applicability', () => {
  it('invalidates ages after 1 to 2 children and preserves the old value without marking a correction', () => {
    const before = profile({ childrenCount: 1, childrenAges: [6] });
    const merged = mergeInterpretation(before, info([{ slot: 'childrenCount', value: 2 }]), 'm', now);
    const result = reconcile(before, merged.profile, merged.providedSlots);
    expect(result.profile.slots.childrenAges).toEqual({ status: 'missing', previousValue: [6] });
    expect(result.invalidated).toEqual(['childrenAges']); expect(result.corrected).toEqual([]);
    expect(before.slots.childrenAges.value).toEqual([6]);
  });
  it('does not resurrect stale ages through 2 to 0 to 1 children', () => {
    const before = profile({ childrenCount: 2, childrenAges: [6, 9], schoolPreference: 'public' });
    const noChildren = mergeInterpretation(before, info([{ slot: 'childrenCount', value: 0 }]), 'm', now);
    const reconciled = reconcile(before, noChildren.profile, noChildren.providedSlots).profile;
    expect(applicability('childrenAges', reconciled)).toBe('not_applicable');
    expect(applicability('schoolPreference', reconciled)).toBe('not_applicable');
    expect(reconciled.slots.schoolPreference.value).toBe('public');
    const one = mergeInterpretation(reconciled, info([{ slot: 'childrenCount', value: 1 }]), 'm2', now);
    expect(reconcile(reconciled, one.profile, one.providedSlots).profile.slots.childrenAges).toEqual({ status: 'missing', previousValue: [6, 9] });
  });
  it('keeps valid ages supplied in the same round, independent of update ordering', () => {
    const before = profile({ childrenCount: 1, childrenAges: [6] });
    for (const updates of [
      [{ slot: 'childrenCount', value: 2 }, { slot: 'childrenAges', value: [6, 9] }],
      [{ slot: 'childrenAges', value: [6, 9] }, { slot: 'childrenCount', value: 2 }],
    ] as SlotUpdate[][]) {
      const result = mergeInterpretation(before, info(updates), 'm', now);
      expect(reconcile(before, result.profile, result.providedSlots).invalidated).toEqual([]);
    }
  });
  it('keeps no-longer-applicable partner data as history, then uses it when applicable again', () => {
    const before = full(); before.slots.hasPartner = { status: 'known', value: true }; before.slots.partnerNationality = { status: 'known', value: 'PT' };
    const after = mergeInterpretation(before, info([{ slot: 'hasPartner', value: false }]), 'm', now).profile;
    expect(applicability('partnerNationality', after)).toBe('not_applicable');
    expect(after.slots.partnerNationality.value).toBe('PT');
    expect(requiredSlots(after)).not.toContain('partnerNationality');
    expect(nextQuestions(after)).not.toEqual(expect.arrayContaining([expect.objectContaining({ slot: 'partnerNationality' })]));
    after.slots.hasPartner = { status: 'missing' };
    expect(applicability('partnerNationality', after)).toBe('pending');
    after.slots.hasPartner = { status: 'known', value: true };
    expect(applicability('partnerNationality', after)).toBe('applicable');
    expect(after.slots.partnerNationality.value).toBe('PT');
  });
  it('does not confuse optional information with inapplicable information', () => {
    const after = profile({ goals: ['tax'], incomeSource: 'freelancer', businessType: 'software' });
    expect(requiredSlots(after)).not.toContain('incomeSource');
    expect(applicability('incomeSource', after)).toBe('applicable');
    expect(applicability('businessType', after)).toBe('applicable');
  });
  it('invalidates residence status only after a changed known country without an explicit status', () => {
    const before = full();
    const changed = mergeInterpretation(before, info([{ slot: 'currentResidence', value: 'PT' }]), 'm', now);
    expect(reconcile(before, changed.profile, changed.providedSlots).profile.slots.residenceStatus).toEqual({ status: 'missing', previousValue: 'citizen' });
    const sameStatus = mergeInterpretation(before, info([{ slot: 'currentResidence', value: 'PT' }, { slot: 'residenceStatus', value: 'citizen' }]), 'm', now);
    expect(reconcile(before, sameStatus.profile, sameStatus.providedSlots).profile.slots.residenceStatus.value).toBe('citizen');
    const newStatus = mergeInterpretation(before, info([{ slot: 'currentResidence', value: 'PT' }, { slot: 'residenceStatus', value: 'permanent_resident' }]), 'm', now);
    expect(reconcile(before, newStatus.profile, newStatus.providedSlots).profile.slots.residenceStatus.value).toBe('permanent_resident');
    const repeated = mergeInterpretation(before, info([{ slot: 'currentResidence', value: 'CN' }]), 'm', now);
    expect(reconcile(before, repeated.profile, repeated.providedSlots).invalidated).toEqual([]);
    const initiallyMissing = profile({ residenceStatus: 'citizen' });
    const firstCountry = mergeInterpretation(initiallyMissing, info([{ slot: 'currentResidence', value: 'PT' }]), 'm', now);
    expect(reconcile(initiallyMissing, firstCountry.profile, firstCountry.providedSlots).invalidated).toEqual([]);
  });
  it('does not count unsure as an explicit replacement identity across a country change', () => {
    const before = full();
    const merged = mergeInterpretation(before, info([{ slot: 'currentResidence', value: 'PT' }], ['residenceStatus']), 'm', now);
    expect(merged.providedSlots).toEqual(['currentResidence']);
    expect(reconcile(before, merged.profile, merged.providedSlots).invalidated).toEqual(['residenceStatus']);
  });
});

describe('completion and questions', () => {
  it('requires three known gate slots for early generation', () => {
    expect(canGenerateEarly(profile({ destination: 'PT', goals: ['tax'] }))).toBe(false);
    expect(canGenerateEarly(profile({ destination: 'PT', goals: ['tax'], applicantNationality: 'CN' }))).toBe(true);
    expect(isComplete(profile({ destination: 'PT', goals: ['tax'], applicantNationality: 'CN' }))).toBe(false);
  });
  it('counts unsure as answered and changes requirements with goals and family', () => {
    const after = full(); after.slots.timeline = { status: 'unsure' };
    expect(progress(after)).toEqual({ required: 9, answered: 9, missing: [], unsure: ['timeline'], isComplete: true, canGenerateEarly: true });
    after.slots.goals = { status: 'known', value: ['residence', 'tax', 'education'] };
    expect(progress(after).missing).toEqual(['incomeCountry']);
    after.slots.childrenCount = { status: 'known', value: 1 };
    expect(progress(after).missing).toEqual(['childrenAges', 'incomeCountry', 'schoolPreference']);
  });
  it('asks at most two missing required slots in priority order and skips unsure', () => {
    expect(nextQuestions(profile()).map(question => question.slot)).toEqual(['destination', 'goals']);
    const after = full(); after.slots.timeline = { status: 'unsure' }; after.slots.incomeSource = { status: 'missing' };
    const questions = nextQuestions(after);
    expect(questions.map(question => question.slot)).toEqual(['incomeSource']);
    expect(questions[0]?.options.at(-1)).toEqual({ label: '不确定', value: { unsure: true } });
    after.slots.incomeSource = { status: 'unsure' };
    expect(nextQuestions(after)).toEqual([]);
  });
});
