import { describe, expect, it } from 'vitest';
import { createEmptyProfile, planContentSchema } from '@nomad/shared';
import type { Profile, SlotKey } from '@nomad/shared';
import { createDomain } from '../../src/domain/index.js';
import { generatePlan, selectSteps } from '../../src/domain/plan/generate.js';
import { mergeInterpretation, progress } from '../../src/domain/profile.js';
import { nextQuestions } from '../../src/domain/policy.js';
import { loadKnowledge } from '../../src/knowledge/loader.js';
import { knowledgeFileSchema } from '../../src/knowledge/schema.js';
import type { KnowledgeCatalog, KnowledgeFile, KnowledgeStep } from '../../src/knowledge/schema.js';

const catalog = loadKnowledge();
const now = '2026-10-31T02:00:00.000Z';
function profile(values: Partial<Record<SlotKey, unknown>> = {}): Profile {
  const result = createEmptyProfile();
  for (const [key, value] of Object.entries({ destination: 'PT', goals: ['residence', 'company', 'tax', 'education', 'healthcare'], applicantNationality: 'CN', ...values })) result.slots[key as SlotKey] = { status: 'known', value };
  return result;
}
function step(id: string, overrides: Partial<KnowledgeStep> = {}): KnowledgeStep {
  return { id, goal: 'general', phase: 'before', priority: 10, title: `了解 ${id}`, why: '准备咨询', materials: [], dependsOn: [], needsProfessional: false, sources: [{ label: '示例官方机构' }], ...overrides };
}
function knowledge(steps: KnowledgeStep[]): KnowledgeFile { return { country: 'PT', coverage: 'full', version: 'test', steps }; }
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
const ids = (input: Profile) => generatePlan(input, now, true, catalog).phases.flatMap(phase => phase.steps.map(item => item.id));

describe('knowledge validation', () => {
  it('loads a full Portugal catalog and an eight-step generic catalog', () => {
    expect(catalog.portugal.steps.length).toBeGreaterThanOrEqual(20);
    expect(catalog.generic.steps).toHaveLength(8);
    expect(catalog.portugal).toMatchObject({ country: 'PT', coverage: 'full' });
    expect(catalog.generic.coverage).toBe('generic');
    for (const entry of [catalog.portugal, catalog.generic]) {
      expect(new Set(entry.steps.map(item => item.id)).size).toBe(entry.steps.length);
      for (const item of entry.steps) {
        expect(`${item.title} ${item.why}`).not.toMatch(/你可以申请|你符合|你需要缴纳|\d+\s*(%|欧元)/);
        if (item.goal === 'tax' || item.goal === 'residence') expect(item.needsProfessional).toBe(true);
      }
    }
  });
  it('rejects duplicate ids and nonexistent dependencies', () => {
    expect(knowledgeFileSchema.safeParse(knowledge([step('a'), step('a')])).success).toBe(false);
    expect(knowledgeFileSchema.safeParse(knowledge([step('a', { dependsOn: ['missing'] })])).success).toBe(false);
  });
  it('rejects cycles and dependencies pointing at a later phase', () => {
    expect(knowledgeFileSchema.safeParse(knowledge([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })])).success).toBe(false);
    expect(knowledgeFileSchema.safeParse(knowledge([step('a', { dependsOn: ['b'] }), step('b', { phase: 'arrival' })])).success).toBe(false);
    expect(knowledgeFileSchema.safeParse(knowledge([step('a'), step('b', { phase: 'arrival', dependsOn: ['a'] })])).success).toBe(true);
  });
});

describe('personalized plans', () => {
  it('distinguishes EU and non-EU consultation directions without stating eligibility', () => {
    const nonEu = profile({ hasPartner: false, childrenCount: 0 });
    const eu = profile({ applicantNationality: 'PT', hasPartner: false, childrenCount: 0 });
    expect(ids(nonEu)).toContain('pt-residence-route');
    expect(ids(nonEu)).not.toContain('pt-residence-eu');
    expect(ids(eu)).toContain('pt-residence-eu');
    expect(ids(eu)).not.toContain('pt-residence-route');
    const plan = generatePlan(eu, now, true, catalog);
    expect(plan.disclaimer).toContain('只代表值得了解的方向');
    expect(plan.disclaimer).toContain('不能替代持牌专业人士的意见');
    expect(plan.sources.every(source => source.note === '演示用途，未做时效核实')).toBe(true);
  });
  it('includes conditional partner paths when applicability is pending, but not when partner is explicitly absent', () => {
    const pending = profile({ partnerNationality: 'PT' });
    const pendingPlan = generatePlan(pending, now, true, catalog);
    const familyStep = pendingPlan.phases.flatMap(phase => phase.steps).find(item => item.id === 'pt-residence-family');
    expect(familyStep?.conditional).toContain('配偶或伴侣同行（待确认）');
    expect(familyStep?.conditional).toContain('配偶国籍（待确认）');
    expect(pendingPlan.profileSummary.toConfirm.some(item => item.label === '咨询配偶相关的家庭居留方向')).toBe(true);
    const absent = profile({ hasPartner: false, partnerNationality: 'PT' });
    const absentPlan = generatePlan(absent, now, true, catalog);
    expect(ids(absent)).not.toContain('pt-residence-family');
    expect(absentPlan.profileSummary.known.some(item => item.slot === 'partnerNationality')).toBe(false);
    expect(absent.slots.partnerNationality.value).toBe('PT');
  });
  it('filters education steps and historical child details only when children are explicitly absent', () => {
    expect(ids(profile({ childrenCount: 0, childrenAges: [6], schoolPreference: 'public' })).some(id => id.startsWith('pt-school-'))).toBe(false);
    const children = profile({ childrenCount: 1, childrenAges: [6], schoolPreference: 'public' });
    expect(ids(children)).toContain('pt-school-public');
    expect(ids(children)).not.toContain('pt-school-international');
    const undecided = profile({ childrenCount: 1 });
    const school = generatePlan(undecided, now, true, catalog).phases.flatMap(phase => phase.steps).filter(item => item.id.startsWith('pt-school-') && item.conditional);
    expect(school.map(item => item.id)).toEqual(['pt-school-international', 'pt-school-public']);
    expect(school.every(item => item.conditional?.includes('学校偏好（待确认）'))).toBe(true);
  });
  it('preserves provided optional facts in the summary and professional conditions after removing a goal', () => {
    const before = profile({ goals: ['residence', 'company', 'tax'], incomeSource: 'freelancer', businessType: 'software' });
    const merged = mergeInterpretation(before, { intent: 'provide_info', updates: [{ slot: 'goals', value: ['company', 'residence'], op: 'remove' }], unsure: [] }, 'm', now);
    expect(merged.profile.slots.goals.value).toEqual(['tax']);
    expect(merged.profile.slots.businessType.value).toBe('software');
    expect(progress(merged.profile).missing).not.toContain('businessType');
    expect(nextQuestions(merged.profile).map(question => question.slot)).not.toContain('businessType');
    const plan = generatePlan(merged.profile, now, true, catalog);
    expect(plan.phases.flatMap(phase => phase.steps).some(item => item.goal === 'company')).toBe(false);
    expect(plan.profileSummary.known).toEqual(expect.arrayContaining([{ slot: 'incomeSource', label: '主要收入来源', display: '自由职业' }, { slot: 'businessType', label: '公司业务类型', display: '软件技术' }]));
    expect(plan.professionalBoundary[0]?.conditions).toContain('主要收入来源：自由职业');
  });
  it('puts missing and unsure facts in separate sections, and marks uncertain step conditions', () => {
    const input = profile({ hasPartner: false, childrenCount: 0 }); input.slots.hasHealthInsurance = { status: 'unsure' };
    const plan = generatePlan(input, now, true, catalog);
    expect(plan.profileSummary.unknown).toContainEqual({ slot: 'timeline', label: '计划时间' });
    expect(plan.profileSummary.toConfirm).toContainEqual({ slot: 'hasHealthInsurance', label: '是否已有医疗保险', reason: '已标为不确定，需要后续确认' });
    expect(plan.phases.flatMap(phase => phase.steps).find(item => item.id === 'pt-health-insurance')?.conditional).toContain('是否已有医疗保险（待确认）');
    expect(plan.generatedEarly).toBe(true);
  });
  it('uses a generic checklist for an uncovered destination and never leaks Portugal-specific steps', () => {
    const plan = generatePlan(profile({ destination: 'CL' }), now, true, catalog);
    expect(plan).toMatchObject({ destination: 'CL', coverage: 'generic', firstStepId: 'generic-passport' });
    expect(plan.phases.flatMap(phase => phase.steps)).toHaveLength(8);
    expect(plan.phases.flatMap(phase => phase.steps).every(item => item.id.startsWith('generic-'))).toBe(true);
    expect(plan.title).toContain('智利');
  });
  it('orders dependencies before priority, keeps only included dependency ids, and breaks ties by id', () => {
    const source = knowledge([
      step('b', { priority: 1, dependsOn: ['a'] }), step('a', { priority: 50 }), step('c', { priority: 50 }),
      step('company', { goal: 'company' }), step('filtered-dependency', { phase: 'arrival', dependsOn: ['company'] }),
    ]);
    const input = profile({ goals: ['tax'] });
    expect(selectSteps(input, source).map(item => item.step.id)).toEqual(['a', 'b', 'c', 'filtered-dependency']);
    const custom: KnowledgeCatalog = { portugal: source, generic: catalog.generic };
    const plan = generatePlan(input, now, true, custom);
    expect(plan.phases[1]?.steps[0]?.dependsOn).toEqual([]);
    expect(plan.firstStepId).toBe('a');
  });
  it('chooses the first step from the earliest phase before comparing priority or id', () => {
    const source = knowledge([step('z-before', { priority: 99 }), step('a-arrival', { phase: 'arrival', priority: 0 }), step('b-before', { priority: 99 })]);
    const plan = generatePlan(profile(), now, true, { portugal: source, generic: catalog.generic });
    expect(plan.firstStepId).toBe('b-before');
  });
  it('evaluates every supported condition without inventing missing facts', () => {
    const source = knowledge([
      step('portuguese-partner', { when: { partnerGroup: 'portugal' } }),
      step('non-eu-partner', { when: { partnerGroup: 'non_eu' } }),
      step('freelancer', { when: { incomeSourceIn: ['freelancer'] } }),
      step('insured', { when: { hasHealthInsurance: true } }),
      step('no-children', { when: { hasChildren: false } }),
    ]);
    const input = profile({ hasPartner: true, partnerNationality: 'PT', incomeSource: 'freelancer', hasHealthInsurance: true, childrenCount: 0 });
    expect(selectSteps(input, source).map(item => item.step.id)).toEqual(['freelancer', 'insured', 'no-children', 'portuguese-partner']);
    expect(selectSteps(profile(), source).every(item => item.uncertainSlots.length > 0)).toBe(true);
  });
  it('has deterministic immutable outputs that match the shared schema and factory contract', () => {
    const input = frozen(profile({ hasPartner: false, childrenCount: 0 }));
    const knowledgeInput = frozen(structuredClone(catalog));
    const domain = createDomain(knowledgeInput);
    const first = domain.generatePlan(input, now, false);
    expect(domain.generatePlan(input, now, false)).toEqual(first);
    expect(planContentSchema.parse(first)).toEqual(first);
    expect(first.generatedAt).toBe(now);
    expect(() => domain.generatePlan(createEmptyProfile(), now, true)).toThrow('requires destination');
  });
});
