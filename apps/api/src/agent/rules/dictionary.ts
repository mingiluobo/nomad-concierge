import type { Goal, SlotKey } from '@nomad/shared';
export const goalWords: [Goal, RegExp][] = [
  ['residence', /签证|居留|移民|搬到|移居|定居|(?:去|到|前往).{0,20}(?:生活|住)/],
  ['company', /公司|注册|创业|做生意/], ['tax', /税|报税/], ['education', /上学|学校|入学/], ['healthcare', /看病|医疗|医保/],
];
export const enumWords: { slot: SlotKey; values: [unknown, RegExp][] }[] = [
  { slot: 'timeline', values: [
    ['lt3m', /下(?:个)?月|下周|下星期|本月|这(?:个)?月|尽快|马上|(?<![零〇一二两三四五六七八九十\d])(?:[一二两12]个?月(?:后|内)|[三3]个月内)/],
    ['3to6m', /半年内|(?<![零〇一二两三四五六七八九十\d])[三四五345]个月后|3[～到至-]6个月|三到六个月/],
    ['6to12m', /明年|半年后|(?<![零〇一二两三四五六七八九十\d])(?:[六七八九6789]|十一?|10|11)个月后|6[～到至-]12个月|六到十二个月/],
    ['gt12m', /一年以[后上]|一年后|两年后|(?<![零〇一二两三四五六七八九十\d])(?:十二|12)个月后/],
  ] },
  { slot: 'incomeSource', values: [['remote_employee', /远程办公|远程雇员|远程工作/], ['freelancer', /自由职业|接单|独立设计师/], ['business_owner', /自己做生意|企业主|自己经营/], ['passive_income', /被动收入|租金|退休金/]] },
  { slot: 'residenceStatus', values: [['permanent_resident', /永久居民|永居/], ['work_or_study_visa', /工作签证|学习签证|学生签证|留学签证/], ['citizen', /公民/], ['other', /其他身份|其他居留/]] },
  { slot: 'businessType', values: [['consulting', /咨询服务|咨询业务/], ['ecommerce', /电商|电子商务/], ['software', /软件|技术服务/], ['other', /其他业务/]] },
  { slot: 'schoolPreference', values: [['public', /公立/], ['international', /国际学校/]] },
  { slot: 'hasHealthInsurance', values: [[false, /没有(?:医疗)?保险|没(?:有)?医保|未(?:买|有)(?:医疗)?保险/], [true, /(?:已经|已|有)(?:有|买了)?的?医疗保险|已有的?医保|有医保|有保险/]] },
];
export const partnerWords = '配偶|老婆|老公|妻子|丈夫|爱人|伴侣|太太|先生';
export const unsureWords = /不知道|不确定|还没想好|没想好|看情况|跳过|不清楚/;
export const countrySlots: SlotKey[] = ['destination', 'applicantNationality', 'partnerNationality', 'currentResidence', 'incomeCountry'];
