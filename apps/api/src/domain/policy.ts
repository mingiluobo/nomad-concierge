import { slots, slotOptions } from '@nomad/shared';
import type { AssistantPayload, Profile } from '@nomad/shared';
import { requiredSlots } from './profile.js';

export function nextQuestions(profile: Profile): AssistantPayload['questions'] {
  return requiredSlots(profile).filter(slot => profile.slots[slot].status === 'missing').slice(0, 2).map(slot => ({
    slot, text: slots[slot].question, options: slotOptions(slot, profile), allowUnsure: slots[slot].allowUnsure,
  }));
}
