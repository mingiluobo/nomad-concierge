import type { Domain } from '../composition.js';
import type { KnowledgeCatalog } from '../knowledge/schema.js';
import { mergeInterpretation, reconcile, progress } from './profile.js';
import { nextQuestions } from './policy.js';
import { composeReply, renderReplyText } from './replies.js';
import { generateTitle } from './title.js';
import { generatePlan } from './plan/generate.js';

export function createDomain(knowledge: KnowledgeCatalog): Domain {
  return { mergeInterpretation, reconcile, progress, nextQuestions, composeReply, renderReplyText, generateTitle,
    generatePlan: (profile, now, generatedEarly) => generatePlan(profile, now, generatedEarly, knowledge) };
}

export { mergeInterpretation, reconcile, progress, applicability, requiredSlots, isComplete, canGenerateEarly, formatSlot } from './profile.js';
export { nextQuestions } from './policy.js';
export { composeReply, renderReplyText } from './replies.js';
export { professionalConditions } from './professional.js';
export { generateTitle, householdSummary } from './title.js';
export { canTransition, transition, IllegalTransitionError } from './stateMachine.js';
