import { slots } from '@nomad/shared';
import type { ProfessionalTopic, Profile, SlotKey } from '@nomad/shared';
import { applicability, formatSlot } from './profile.js';

export interface ProfessionalCondition { label: string; slot?: SlotKey; known: boolean; display?: string }
const topicSlots: Record<ProfessionalTopic, SlotKey[]> = {
  visa_eligibility: ['applicantNationality', 'partnerNationality', 'incomeSource', 'timeline'],
  tax_amount: ['incomeCountry', 'incomeSource'], company_setup: ['businessType', 'applicantNationality'], other: ['destination', 'goals'],
};
const fixedConditions: Partial<Record<ProfessionalTopic, string>> = {
  visa_eligibility: '收入证明、无犯罪记录、住所等材料要求',
  tax_amount: '税务居民身份取决于实际居住时间，以及两国之间的税收协定',
  company_setup: '外国人在目的国开公司，通常还取决于在当地的居留身份',
};
export function professionalConditions(topic: ProfessionalTopic, profile: Profile): ProfessionalCondition[] {
  const conditions: ProfessionalCondition[] = topicSlots[topic].filter(slot => applicability(slot, profile) !== 'not_applicable').map(slot => ({
    slot, label: slots[slot].label, known: profile.slots[slot].status === 'known', display: formatSlot(profile, slot),
  }));
  const fixed = fixedConditions[topic];
  if (fixed) conditions.push({ label: fixed, known: false });
  return conditions;
}
