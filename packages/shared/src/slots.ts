import { z } from 'zod';
import { countryCodeSchema, countryName } from './countries.js';
import type { Profile, SlotKey } from './profile.js';

export const goals = ['residence', 'company', 'tax', 'education', 'healthcare'] as const;
export const goalSchema = z.enum(goals);
export type Goal = z.infer<typeof goalSchema>;
export const incomeSourceSchema = z.enum(['remote_employee', 'freelancer', 'business_owner', 'passive_income']);
export type IncomeSource = z.infer<typeof incomeSourceSchema>;
export const schoolPreferenceSchema = z.enum(['public', 'international']);
export type SchoolPreference = z.infer<typeof schoolPreferenceSchema>;
export const residenceStatusSchema = z.enum(['citizen', 'permanent_resident', 'work_or_study_visa', 'other']);
export const timelineSchema = z.enum(['lt3m', '3to6m', '6to12m', 'gt12m']);
export const businessTypeSchema = z.enum(['consulting', 'ecommerce', 'software', 'other']);
export type ResidenceStatus = z.infer<typeof residenceStatusSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export type BusinessType = z.infer<typeof businessTypeSchema>;
export interface SlotDef<T = unknown> {
  key: SlotKey;
  label: string;
  group: 'base' | 'goal';
  valueSchema: z.ZodType<T>;
  requiredWhen: (profile: Profile) => boolean;
  priority: number;
  allowUnsure: boolean;
  question: string;
  options?: { label: string; value: T }[];
  format: (value: T) => string;
  llmHint: string;
  aliases: string[];
}
const labels: Record<string, string> = {
  residence: '居留', company: '开公司', tax: '税务', education: '子女教育', healthcare: '医疗',
  citizen: '公民', permanent_resident: '永久居民', work_or_study_visa: '工作或学习签证', other: '其他',
  lt3m: '3 个月内', '3to6m': '3～6 个月', '6to12m': '6～12 个月', gt12m: '一年以后',
  remote_employee: '远程雇员', freelancer: '自由职业', business_owner: '自己做生意', passive_income: '被动收入',
  consulting: '咨询服务', ecommerce: '电商', software: '软件技术', public: '公立', international: '国际学校',
};
const label = (value: unknown): string => labels[String(value)] ?? String(value);
const enumOptions = (values: readonly string[]): { label: string; value: unknown }[] => values.map(value => ({ label: label(value), value }));
const always = () => true;
const knownValue = (profile: Profile, key: SlotKey): unknown => profile.slots[key].status === 'known' ? profile.slots[key].value : undefined;
const hasGoal = (goal: Goal) => (profile: Profile): boolean => {
  const value = knownValue(profile, 'goals');
  return Array.isArray(value) && value.includes(goal);
};
const hasChildren = (profile: Profile): boolean => Number(knownValue(profile, 'childrenCount') ?? 0) > 0;
const countryFormat = (value: unknown) => countryName(String(value));
export const slots: Record<SlotKey, SlotDef> = {
  destination: { key: 'destination', label: '目的国', group: 'base', valueSchema: countryCodeSchema, requiredWhen: always, priority: 1, allowUnsure: false, question: '你打算去哪个国家？', options: [{ label: '葡萄牙', value: 'PT' }], format: countryFormat, llmHint: '目的国，ISO 3166-1 alpha-2 国家代码，仅用户明确提及时填写', aliases: ['目的国', '目的地', '去哪个国家'] },
  goals: { key: 'goals', label: '诉求', group: 'base', valueSchema: z.array(goalSchema).min(1), requiredWhen: always, priority: 2, allowUnsure: false, question: '你需要了解哪些事？可以多选。', options: goals.map(value => ({ label: label(value), value: [value] })), format: value => (value as Goal[]).map(label).join('、'), llmHint: '非空数组：residence 居留、company 开公司、tax 税务、education 子女教育、healthcare 医疗；新增用 add，否定用 remove，明确替换用 set', aliases: ['诉求', '需求', '想了解的事'] },
  applicantNationality: { key: 'applicantNationality', label: '本人国籍', group: 'base', valueSchema: countryCodeSchema, requiredWhen: always, priority: 3, allowUnsure: false, question: '你的国籍是哪个国家？', options: [{ label: '中国', value: 'CN' }, { label: '葡萄牙', value: 'PT' }], format: countryFormat, llmHint: '本人国籍，ISO 国家代码；不能根据语言推断', aliases: ['本人国籍', '我的国籍', '国籍', '护照'] },
  hasPartner: { key: 'hasPartner', label: '配偶或伴侣同行', group: 'base', valueSchema: z.boolean(), requiredWhen: always, priority: 4, allowUnsure: false, question: '有配偶或伴侣一起去吗？', options: [{ label: '是', value: true }, { label: '否', value: false }], format: value => value ? '是' : '否', llmHint: '布尔值，是否有配偶或伴侣同行', aliases: ['配偶同行', '伴侣同行', '是否同行'] },
  partnerNationality: { key: 'partnerNationality', label: '配偶国籍', group: 'base', valueSchema: countryCodeSchema, requiredWhen: profile => knownValue(profile, 'hasPartner') === true, priority: 5, allowUnsure: true, question: '配偶或伴侣的国籍是哪个国家？', format: countryFormat, llmHint: '配偶或伴侣的国籍，ISO 国家代码', aliases: ['配偶国籍', '伴侣国籍', '老婆国籍', '老公国籍'] },
  childrenCount: { key: 'childrenCount', label: '孩子人数', group: 'base', valueSchema: z.number().int().min(0).max(10), requiredWhen: always, priority: 6, allowUnsure: false, question: '有几个孩子一起去？', options: [{ label: '没有', value: 0 }, { label: '1 个', value: 1 }, { label: '2 个', value: 2 }], format: value => `${value} 个`, llmHint: '整数 0～10，同行的孩子人数；只说带孩子不能猜数量', aliases: ['孩子人数', '几个孩子', '孩子数量'] },
  childrenAges: { key: 'childrenAges', label: '孩子年龄', group: 'base', valueSchema: z.array(z.number().int().min(0).max(25)).max(10), requiredWhen: hasChildren, priority: 7, allowUnsure: true, question: '孩子分别多大？', format: value => (value as number[]).map(age => `${age} 岁`).join('、'), llmHint: '整数数组，每项 0～25，人数一致性在合并后检查', aliases: ['孩子年龄', '年龄', '孩子多大', '几岁'] },
  currentResidence: { key: 'currentResidence', label: '当前居住国', group: 'base', valueSchema: countryCodeSchema, requiredWhen: always, priority: 8, allowUnsure: false, question: '你目前住在哪个国家？', options: [{ label: '中国', value: 'CN' }], format: countryFormat, llmHint: '当前居住国，ISO 国家代码；不能根据语言或国籍推断', aliases: ['当前居住国', '居住国', '目前住哪', '现在住哪'] },
  residenceStatus: { key: 'residenceStatus', label: '在当前居住国的身份', group: 'base', valueSchema: residenceStatusSchema, requiredWhen: always, priority: 9, allowUnsure: true, question: '你在当前居住国是什么身份？', options: enumOptions(residenceStatusSchema.options), format: label, llmHint: 'citizen 公民、permanent_resident 永久居民、work_or_study_visa 工作或学习签证、other 其他；仅明确提供时填写', aliases: ['居留身份', '身份', '居住身份'] },
  timeline: { key: 'timeline', label: '计划时间', group: 'base', valueSchema: timelineSchema, requiredWhen: always, priority: 10, allowUnsure: true, question: '你计划什么时候出发？', options: enumOptions(timelineSchema.options), format: label, llmHint: 'lt3m 3个月内、3to6m 3到6个月、6to12m 6到12个月、gt12m 一年以后', aliases: ['时间', '什么时候', '出发时间'] },
  incomeSource: { key: 'incomeSource', label: '主要收入来源', group: 'goal', valueSchema: incomeSourceSchema, requiredWhen: hasGoal('residence'), priority: 11, allowUnsure: true, question: '你的主要收入来源是什么？', options: enumOptions(incomeSourceSchema.options), format: label, llmHint: 'remote_employee 远程雇员、freelancer 自由职业、business_owner 自己做生意、passive_income 被动收入', aliases: ['收入来源', '收入类型', '主要收入'] },
  businessType: { key: 'businessType', label: '公司业务类型', group: 'goal', valueSchema: businessTypeSchema, requiredWhen: hasGoal('company'), priority: 12, allowUnsure: true, question: '公司主要做什么业务？', options: enumOptions(businessTypeSchema.options), format: label, llmHint: 'consulting 咨询、ecommerce 电商、software 软件技术、other 其他', aliases: ['业务类型', '公司业务', '做什么业务'] },
  incomeCountry: { key: 'incomeCountry', label: '主要收入来源国', group: 'goal', valueSchema: countryCodeSchema, requiredWhen: hasGoal('tax'), priority: 13, allowUnsure: true, question: '你的收入主要来自哪个国家？', options: [{ label: '中国', value: 'CN' }], format: countryFormat, llmHint: '主要收入来源国，ISO 国家代码', aliases: ['收入来源国', '收入国家', '客户国家'] },
  schoolPreference: { key: 'schoolPreference', label: '学校偏好', group: 'goal', valueSchema: schoolPreferenceSchema, requiredWhen: profile => hasGoal('education')(profile) && hasChildren(profile), priority: 14, allowUnsure: true, question: '孩子更倾向于公立还是国际学校？', options: enumOptions(schoolPreferenceSchema.options), format: label, llmHint: 'public 公立、international 国际学校', aliases: ['学校偏好', '学校类型', '学校'] },
  hasHealthInsurance: { key: 'hasHealthInsurance', label: '是否已有医疗保险', group: 'goal', valueSchema: z.boolean(), requiredWhen: hasGoal('healthcare'), priority: 15, allowUnsure: true, question: '目前已有医疗保险吗？', options: [{ label: '已有', value: true }, { label: '没有', value: false }], format: value => value ? '已有' : '没有', llmHint: '布尔值，是否已有医疗保险', aliases: ['医疗保险', '医保', '保险'] },
};
export const slotDefinitions = Object.values(slots).sort((a, b) => a.priority - b.priority);
export const unsureValueSchema = z.object({ unsure: z.literal(true) }).strict();
export function slotOptions(key: SlotKey, profile: Profile): { label: string; value: unknown }[] {
  const definition = slots[key];
  const options = [...(definition.options ?? [])];
  if (key === 'partnerNationality' && profile.slots.applicantNationality.status === 'known') {
    options.push({ label: '同本人国籍', value: profile.slots.applicantNationality.value });
  }
  if (definition.allowUnsure) options.push({ label: '不确定', value: { unsure: true } });
  return options;
}
