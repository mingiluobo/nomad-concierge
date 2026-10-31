import { countries, slotDefinitions, slots } from '@nomad/shared';
import type { Goal, Interpretation, ProfessionalTopic, SlotKey, SlotUpdate } from '@nomad/shared';
import type { InterpretInput, InterpretResult, Interpreter } from '../interpreter.js';
import { throwIfAborted } from '../interpreter.js';
import { chineseNumber, numberPattern } from './numbers.js';
import { countrySlots, enumWords, goalWords, partnerWords, unsureWords } from './dictionary.js';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countryAliases = countries.flatMap(country => country.aliases.map(alias => ({ code: country.code, alias }))).sort((a, b) => b.alias.length - a.alias.length);
function countryMentions(text: string): { code: string; alias: string; index: number; end: number }[] {
  const found: { code: string; alias: string; index: number; end: number }[] = [];
  for (const { code, alias } of countryAliases) {
    const pattern = new RegExp(`${/^[a-z ]+$/i.test(alias) ? '(?<![a-z])' : ''}${escape(alias)}${/^[a-z ]+$/i.test(alias) ? '(?![a-z])' : ''}`, 'gi');
    for (const match of text.matchAll(pattern)) {
      const index = match.index; const end = index + match[0].length;
      if (!found.some(item => index < item.end && end > item.index)) found.push({ code, alias: match[0], index, end });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}
function professionalTopic(text: string): ProfessionalTopic | undefined {
  if (!/能不能申请|可以申请吗|能申请吗|符合.{0,20}条件|要交多少|税率|多少税|合法吗|会被拒吗/.test(text)) return undefined;
  return /税/.test(text) ? 'tax_amount' : /公司|注册|创业/.test(text) ? 'company_setup' : /签证|申请|拒|居留/.test(text) ? 'visa_eligibility' : 'other';
}
function interpretMessage(text: string, input: InterpretInput, droppedUpdates: InterpretResult['droppedUpdates']): Interpretation {
  const updates: SlotUpdate[] = [];
  const unsure = new Set<SlotKey>();
  const add = (slot: SlotKey, value: unknown, op?: SlotUpdate['op']) => {
    if (slots[slot].valueSchema.safeParse(value).success) updates.push({ slot, value, ...(op ? { op } : {}) });
    else droppedUpdates.push({ slot, reason: 'Invalid slot value' });
  };
  const markUnsure = (slot: SlotKey) => {
    if (slots[slot].allowUnsure) unsure.add(slot);
    else droppedUpdates.push({ slot, reason: 'This slot does not allow unsure' });
  };
  const clauses = text.split(/[，。！？；,!?;\n]+/).map(value => value.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (unsureWords.test(clause)) {
      const explicit = slotDefinitions.filter(definition => definition.aliases.some(alias => clause.includes(alias)));
      if (explicit.length) {
        const longest = Math.max(...explicit.map(definition => Math.max(...definition.aliases.filter(alias => clause.includes(alias)).map(alias => alias.length))));
        for (const definition of explicit) if (definition.aliases.some(alias => alias.length === longest && clause.includes(alias))) markUnsure(definition.key);
      } else if (/都(?:不知道|不确定|没想好|还没想好|不清楚)/.test(clause)) {
        for (const slot of input.pendingSlots) markUnsure(slot);
      } else if (input.pendingSlots.length === 1) markUnsure(input.pendingSlots[0]!);
    }
    let previousCountryEnd = 0;
    for (const mention of countryMentions(clause)) {
      const prefix = clause.slice(previousCountryEnd, mention.index); const suffix = clause.slice(mention.end);
      previousCountryEnd = mention.end;
      let key: SlotKey | undefined;
      if (/收入来自|客户(?:都)?在|工资从/.test(prefix)) key = 'incomeCountry';
      else if (/现在住在|目前(?:住)?在|人在|居住在/.test(prefix)) key = 'currentResidence';
      else if (/搬到|移居|前往|定居|(?:去|到)[^，。]*$/.test(prefix)) key = 'destination';
      else if (/籍|国籍|护照|人/.test(mention.alias + suffix) || /国籍|护照|是/.test(prefix)) {
        if (/都是|我们.*都是/.test(prefix)) { add('applicantNationality', mention.code); add('partnerNationality', mention.code); continue; }
        key = new RegExp(partnerWords).test(prefix) ? 'partnerNationality' : 'applicantNationality';
      } else key = input.pendingSlots.find(slot => countrySlots.includes(slot));
      if (key) add(key, mention.code);
    }
    if (new RegExp(`我和(?:我的)?(?:${partnerWords})|(?:${partnerWords}).{0,8}(?:同行|一起去)`).test(clause)) add('hasPartner', true);
    if (/一个人|单身|独自/.test(clause)) add('hasPartner', false);
    let explicitCount = false;
    if (/没有孩子|不带孩子|没有小孩|无子女/.test(clause)) { add('childrenCount', 0); explicitCount = true; }
    else {
      const count = new RegExp(`(${numberPattern})\\s*个?\\s*(?:孩子|小孩|子女)`).exec(clause);
      const shortCount = input.pendingSlots.includes('childrenCount') ? new RegExp(`^(?:是)?(${numberPattern})\\s*个?$`).exec(clause) : null;
      const number = count?.[1] ?? shortCount?.[1];
      if (number) { const value = chineseNumber(number); if (value !== null) { add('childrenCount', value); explicitCount = true; } }
    }
    if (/孩子|小孩|子女|一个.{0,8}岁/.test(clause) || input.pendingSlots.includes('childrenAges')) {
      const ages = [...clause.matchAll(new RegExp(`(${numberPattern})\\s*岁`, 'g'))].map(match => chineseNumber(match[1]!)).filter((value): value is number => value !== null);
      if (ages.length) { add('childrenAges', ages); if (!explicitCount) add('childrenCount', ages.length); }
    }
    const operations = new Map<SlotUpdate['op'], Goal[]>();
    for (const [goal, expression] of goalWords) {
      const hit = expression.exec(clause);
      if (!hit) continue;
      const prefix = clause.slice(0, hit.index);
      const op = /只想|只要|只(?:了解|开)|改成|替换成/.test(clause) ? 'set' : /(?:不|没)(?:开|要|需要|考虑|想|了解|办|再|注册){0,3}$/.test(prefix) ? 'remove' : 'add';
      operations.set(op, [...(operations.get(op) ?? []), goal]);
    }
    for (const [op, value] of operations) add('goals', value, op);
    for (const entry of enumWords) {
      const matches = entry.values.flatMap(([value, expression]) => [...clause.matchAll(new RegExp(expression.source, 'g'))].map(match => ({ value, start: match.index, end: match.index + match[0].length })));
      // A negative phrase can contain a positive one, for example 没有保险 / 有保险.
      const distinct = matches.filter(match => !matches.some(other => other !== match && other.start <= match.start && other.end >= match.end && other.end - other.start > match.end - match.start));
      const match = distinct.sort((a, b) => b.start - a.start)[0];
      if (match) add(entry.slot, match.value);
      else if (input.pendingSlots[0] === entry.slot) {
        const option = slots[entry.slot].options?.find(option => clause === option.label);
        if (option) add(entry.slot, option.value);
      }
    }
    if (input.pendingSlots[0] === 'hasPartner' && /^(是|有|没有|否|不)$/.test(clause)) add('hasPartner', /^(是|有)$/.test(clause));
    if (input.pendingSlots[0] === 'childrenCount' && /^(没有|无)$/.test(clause)) add('childrenCount', 0);
  }
  const topic = professionalTopic(text);
  const related = /出国|出海|移民|签证|目的国|居留|葡萄牙|税|学校|孩子|配偶|公司|医疗/.test(text);
  const intent = topic ? 'ask_professional' : updates.length || unsure.size || unsureWords.test(text) || related ? 'provide_info' : 'off_topic';
  const combined: SlotUpdate[] = [];
  let lastGoals: SlotUpdate | undefined;
  for (const update of updates) {
    if (update.slot === 'goals' && update.op !== 'set' && lastGoals && lastGoals.op === update.op) {
      lastGoals.value = [...new Set([...(lastGoals.value as Goal[]), ...(update.value as Goal[])])];
    } else {
      combined.push(update);
      if (update.slot === 'goals') lastGoals = update;
    }
  }
  return { intent, updates: combined, unsure: [...unsure], ...(topic ? { professionalTopic: topic } : {}) };
}
export class RulesInterpreter implements Interpreter {
  readonly id = 'rules' as const;
  async interpret(input: InterpretInput, signal: AbortSignal): Promise<InterpretResult> {
    throwIfAborted(signal);
    const output: Interpretation = { intent: 'off_topic', updates: [], unsure: [] };
    const droppedUpdates: InterpretResult['droppedUpdates'] = [];
    for (const message of input.newMessages) {
      throwIfAborted(signal);
      const next = interpretMessage(message.content, input, droppedUpdates);
      output.updates.push(...next.updates);
      output.unsure.push(...next.unsure);
      if (next.intent === 'ask_professional') { output.intent = next.intent; output.professionalTopic = next.professionalTopic; }
      else if (next.intent === 'provide_info' && output.intent !== 'ask_professional') output.intent = 'provide_info';
    }
    output.unsure = [...new Set(output.unsure)];
    return { interpretation: output, engineUsed: 'rules', fallbacks: [], droppedUpdates };
  }
}
