import { slotDefinitions, slots } from '@nomad/shared';
import type { Interpretation, Profile, Progress, SlotKey, SlotState } from '@nomad/shared';
import type { MergeResult } from '../composition.js';

export type Applicability = 'applicable' | 'not_applicable' | 'pending';

export function applicability(slot: SlotKey, profile: Profile): Applicability {
  const parent = slot === 'partnerNationality' ? profile.slots.hasPartner
    : slot === 'childrenAges' || slot === 'schoolPreference' ? profile.slots.childrenCount : null;
  if (!parent) return 'applicable';
  if (parent.status !== 'known') return 'pending';
  return parent.value === false || parent.value === 0 ? 'not_applicable' : 'applicable';
}

function emptyResult(profile: Profile): MergeResult {
  return { profile: structuredClone(profile), recorded: [], corrected: [], invalidated: [], droppedUpdates: [], providedSlots: [] };
}

function equalValue(slot: SlotKey, left: unknown, right: unknown): boolean {
  if (slot === 'goals' && Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every(value => right.includes(value));
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeInterpretation(profile: Profile, interpretation: Interpretation, sourceMessageId: string, now: string): MergeResult {
  const result = emptyResult(profile);
  for (const update of interpretation.updates) {
    const definition = slots[update.slot];
    const parsed = definition.valueSchema.safeParse(update.value);
    const op = update.op ?? (update.slot === 'goals' ? 'add' : 'set');
    if (!parsed.success || (update.slot !== 'goals' && op !== 'set')) {
      result.droppedUpdates.push({ slot: update.slot, reason: parsed.success ? 'Operation is only supported for goals' : 'Invalid slot value' });
      continue;
    }
    if (!result.providedSlots.includes(update.slot)) result.providedSlots.push(update.slot);
    const previous = result.profile.slots[update.slot];
    let value: unknown = parsed.data;
    if (update.slot === 'goals') {
      const incoming = [...new Set(parsed.data as string[])];
      const current = previous.status === 'known' ? previous.value as string[] : [];
      value = op === 'add' ? [...new Set([...current, ...incoming])]
        : op === 'remove' ? current.filter(goal => !incoming.includes(goal)) : incoming;
      if (op === 'remove' && (value as string[]).length === 0) continue;
    }
    if (previous.status === 'known' && equalValue(update.slot, previous.value, value)) continue;
    const next: SlotState = { status: 'known', value: structuredClone(value), sourceMessageId, updatedAt: now };
    const isCorrection = previous.status === 'known' && !(update.slot === 'goals' && op === 'add');
    if (isCorrection) {
      next.previousValue = structuredClone(previous.value);
      next.corrected = true;
      result.corrected.push({ slot: update.slot, from: structuredClone(previous.value), to: structuredClone(value) });
    } else {
      result.recorded.push(update.slot);
    }
    result.profile.slots[update.slot] = next;
  }
  for (const slot of interpretation.unsure) {
    if (!slots[slot].allowUnsure) {
      result.droppedUpdates.push({ slot, reason: 'This slot does not allow unsure' });
      continue;
    }
    if (result.profile.slots[slot].status === 'missing') {
      result.profile.slots[slot] = { status: 'unsure', sourceMessageId, updatedAt: now };
      result.recorded.push(slot);
    }
  }
  result.recorded = [...new Set(result.recorded)];
  return result;
}

export function reconcile(before: Profile, after: Profile, providedSlots: readonly SlotKey[]): MergeResult {
  const result = emptyResult(after);
  result.providedSlots = [...new Set(providedSlots)];
  const invalidate = (slot: SlotKey): void => {
    const previous = result.profile.slots[slot];
    if (previous.status === 'missing') return;
    result.profile.slots[slot] = { status: 'missing', ...(previous.status === 'known' ? { previousValue: structuredClone(previous.value) } : {}) };
    result.invalidated.push(slot);
  };
  const count = after.slots.childrenCount;
  const ages = after.slots.childrenAges;
  if (count.status === 'known' && ages.status === 'known' && (ages.value as number[]).length !== count.value) invalidate('childrenAges');
  const formerCountry = before.slots.currentResidence;
  const currentCountry = after.slots.currentResidence;
  if (formerCountry.status === 'known' && currentCountry.status === 'known' && formerCountry.value !== currentCountry.value && !providedSlots.includes('residenceStatus')) {
    invalidate('residenceStatus');
  }
  return result;
}

export function requiredSlots(profile: Profile): SlotKey[] {
  return slotDefinitions.filter(definition => definition.requiredWhen(profile)).map(definition => definition.key);
}

export function canGenerateEarly(profile: Profile): boolean {
  return (['destination', 'goals', 'applicantNationality'] as const).every(slot => profile.slots[slot].status === 'known');
}

export function isComplete(profile: Profile): boolean {
  return requiredSlots(profile).every(slot => profile.slots[slot].status !== 'missing');
}

export function progress(profile: Profile): Progress {
  const required = requiredSlots(profile);
  const missing = required.filter(slot => profile.slots[slot].status === 'missing');
  return { required: required.length, answered: required.length - missing.length, missing,
    unsure: required.filter(slot => profile.slots[slot].status === 'unsure'), isComplete: missing.length === 0, canGenerateEarly: canGenerateEarly(profile) };
}

export function formatSlot(profile: Profile, slot: SlotKey): string {
  const state = profile.slots[slot];
  return state.status === 'known' ? slots[slot].format(state.value) : state.status === 'unsure' ? '不确定' : '待了解';
}
