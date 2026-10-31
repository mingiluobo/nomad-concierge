import { isEuEeaSwiss, slotDefinitions, slots } from '@nomad/shared';
import type { Goal, PlanContent, PlanStep, ProfessionalTopic, Profile, SlotKey } from '@nomad/shared';
import type { KnowledgeCatalog, KnowledgeFile, KnowledgeStep } from '../../knowledge/schema.js';
import { applicability, canGenerateEarly, formatSlot } from '../profile.js';
import { professionalConditions } from '../professional.js';
import { generateTitle } from '../title.js';

const phases = ['before', 'arrival', 'ongoing'] as const;
const phaseLabels = { before: '出发前', arrival: '抵达后', ongoing: '持续事项' };
const sourceNote = '演示用途，未做时效核实';
export const planDisclaimer = '基于演示用示例资料整理，不能替代持牌专业人士的意见。按国籍等条件筛选的步骤只代表值得了解的方向，不是签证资格、税额或其他确定性专业结论。';

interface SelectedStep { step: KnowledgeStep; uncertainSlots: SlotKey[] }

function conditionsFor(step: KnowledgeStep, profile: Profile): { include: boolean; uncertainSlots: SlotKey[] } {
  const uncertainSlots = new Set<SlotKey>();
  let include = true;
  const check = (slot: SlotKey, matches: (value: unknown) => boolean): void => {
    const scope = applicability(slot, profile);
    const state = profile.slots[slot];
    if (scope === 'not_applicable') { include = false; return; }
    if (scope === 'pending' || state.status !== 'known') { uncertainSlots.add(slot); return; }
    if (!matches(state.value)) include = false;
  };
  const when = step.when;
  if (when?.applicantGroup !== undefined) check('applicantNationality', value => (isEuEeaSwiss(String(value)) ? 'eu' : 'non_eu') === when.applicantGroup);
  if (when?.partnerGroup !== undefined) check('partnerNationality', value => when.partnerGroup === 'portugal' ? value === 'PT' : (isEuEeaSwiss(String(value)) ? 'eu' : 'non_eu') === when.partnerGroup);
  if (when?.hasPartner !== undefined) check('hasPartner', value => value === when.hasPartner);
  if (when?.hasChildren !== undefined) check('childrenCount', value => (Number(value) > 0) === when.hasChildren);
  if (when?.incomeSourceIn !== undefined) check('incomeSource', value => when.incomeSourceIn?.some(source => source === value) ?? false);
  if (when?.schoolPreferenceIn !== undefined) check('schoolPreference', value => when.schoolPreferenceIn?.some(preference => preference === value) ?? false);
  if (when?.hasHealthInsurance !== undefined) check('hasHealthInsurance', value => value === when.hasHealthInsurance);
  return { include, uncertainSlots: [...uncertainSlots] };
}

function orderSteps(selected: SelectedStep[]): SelectedStep[] {
  const included = new Set(selected.map(({ step }) => step.id));
  const done = new Set<string>();
  const ordered: SelectedStep[] = [];
  for (const phase of phases) {
    const remaining = selected.filter(({ step }) => step.phase === phase);
    while (remaining.length) {
      const ready = remaining.filter(({ step }) => step.dependsOn.every(dependency => !included.has(dependency) || done.has(dependency)))
        .sort((left, right) => left.step.priority - right.step.priority || left.step.id.localeCompare(right.step.id, 'en'));
      const next = ready[0];
      if (!next) throw new Error('Knowledge dependencies cannot be ordered');
      remaining.splice(remaining.indexOf(next), 1);
      done.add(next.step.id);
      ordered.push(next);
    }
  }
  return ordered;
}

export function selectSteps(profile: Profile, knowledge: KnowledgeFile): SelectedStep[] {
  const goals = profile.slots.goals.status === 'known' ? profile.slots.goals.value as Goal[] : [];
  return orderSteps(knowledge.steps.flatMap(step => {
    if (step.goal !== 'general' && !goals.includes(step.goal)) return [];
    const condition = conditionsFor(step, profile);
    return condition.include ? [{ step, uncertainSlots: condition.uncertainSlots }] : [];
  }));
}

export function generatePlan(profile: Profile, now: string, generatedEarly: boolean, catalog: KnowledgeCatalog): PlanContent {
  if (!canGenerateEarly(profile)) throw new Error('Plan generation requires destination, goals and applicant nationality');
  const destination = String(profile.slots.destination.value);
  const knowledge = destination === 'PT' ? catalog.portugal : catalog.generic;
  const selected = selectSteps(profile, knowledge);
  const selectedIds = new Set(selected.map(({ step }) => step.id));
  const roots = selected.filter(({ step }) => step.dependsOn.every(id => !selectedIds.has(id)))
    .sort((left, right) => phases.indexOf(left.step.phase) - phases.indexOf(right.step.phase) || left.step.priority - right.step.priority || left.step.id.localeCompare(right.step.id, 'en'));
  const first = roots[0];
  if (!first) throw new Error('A plan must have an actionable first step');
  const summary: PlanContent['profileSummary'] = { known: [], unknown: [], toConfirm: [] };
  for (const { key, label } of slotDefinitions) {
    if (applicability(key, profile) === 'not_applicable') continue;
    const state = profile.slots[key];
    if (state.status === 'known') summary.known.push({ slot: key, label, display: formatSlot(profile, key) });
    else if (state.status === 'missing') summary.unknown.push({ slot: key, label });
    else summary.toConfirm.push({ slot: key, label, reason: '已标为不确定，需要后续确认' });
  }
  const steps = new Map<string, PlanStep>();
  const sources = new Map<string, PlanContent['sources'][number]>();
  for (const { step, uncertainSlots } of selected) {
    const conditional = uncertainSlots.length ? `取决于${uncertainSlots.map(slot => `${slots[slot].label}（待确认）`).join('、')}` : undefined;
    steps.set(step.id, { id: step.id, goal: step.goal, title: step.title, why: step.why, materials: [...step.materials],
      dependsOn: step.dependsOn.filter(id => selectedIds.has(id)), needsProfessional: step.needsProfessional,
      ...(step.professionalNote ? { professionalNote: step.professionalNote } : {}), ...(conditional ? { conditional } : {}) });
    if (conditional) summary.toConfirm.push({ label: step.title, reason: conditional });
    for (const source of step.sources) sources.set(`${source.label}:${source.url ?? ''}`, { ...source, note: sourceNote });
  }
  const professionalTopics: Partial<Record<Goal, { topic: ProfessionalTopic; label: string }>> = {
    residence: { topic: 'visa_eligibility', label: '居留' }, tax: { topic: 'tax_amount', label: '税务' }, company: { topic: 'company_setup', label: '开公司' },
  };
  const goals = profile.slots.goals.value as Goal[];
  return {
    schemaVersion: 1, title: `${generateTitle(profile)}${goals.includes('residence') ? '移居' : ''}行动计划`, destination,
    coverage: knowledge.coverage, generatedAt: now, generatedEarly, profileSummary: summary, firstStepId: first.step.id,
    phases: phases.map(phase => ({ phase, label: phaseLabels[phase], steps: selected.filter(({ step }) => step.phase === phase).map(({ step }) => steps.get(step.id)!) })),
    professionalBoundary: goals.flatMap(goal => {
      const topic = professionalTopics[goal];
      return topic ? [{ topic: topic.label, conditions: professionalConditions(topic.topic, profile).map(condition => `${condition.label}${condition.display ? `：${condition.display}` : '（需专业确认）'}`), note: '仅整理影响判断的条件，不能替代持牌专业人士根据完整材料作出的判断。' }] : [];
    }),
    sources: [...sources.values()], disclaimer: planDisclaimer,
  };
}
