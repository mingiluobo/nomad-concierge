import { countryName, slots } from '@nomad/shared';
import type { AssistantPayload } from '@nomad/shared';
import type { ReplyInput } from '../composition.js';
import { formatSlot } from './profile.js';
import { professionalConditions } from './professional.js';

export type ReplyPayload = Omit<AssistantPayload, 'process'>;
const invalidationReasons = {
  childrenAges: '孩子人数变了，孩子年龄需要重新确认',
  residenceStatus: '当前居住国变了，在当前居住国的身份需要重新确认',
} as const;

export function composeReply({ mergeResult, interpretation, progress, nextQuestions, destinationChanged }: ReplyInput): ReplyPayload {
  const profile = mergeResult.profile;
  const notices: AssistantPayload['notices'] = [];
  if (interpretation?.intent === 'off_topic') notices.push({ kind: 'off_topic', text: '这个问题和出海计划关系不大。可以告诉我你打算去哪个国家、需要处理哪些事吗？' });
  if (interpretation?.intent === 'ask_professional') notices.push({
    kind: 'professional',
    text: '能不能申请某类签证（或者要交多少税），需要持牌专业人士根据完整材料判断，我没办法给出结论；这里用到的资料也只是演示用途，可能不完整或过时。影响这个问题的主要条件有：',
    conditions: professionalConditions(interpretation.professionalTopic ?? 'other', profile),
  });
  if (interpretation?.intent === 'provide_info' && interpretation.updates.length === 0 && interpretation.unsure.length === 0) notices.push({ kind: 'not_understood', text: '我没能从这句话里识别出新的信息。可以换个说法，或者直接点下面的选项。' });
  const destination = profile.slots.destination;
  if (destinationChanged && destination.status === 'known' && destination.value !== 'PT') notices.push({ kind: 'unsupported_destination', text: `目前只有葡萄牙的详细资料，${countryName(String(destination.value))}会给出通用的准备清单。` });
  if (progress.isComplete) notices.push({ kind: 'ready', text: '信息已经足够，可以生成计划了。你也可以继续补充。' });
  return {
    recorded: [...new Set(mergeResult.recorded)].map(slot => ({ slot, label: slots[slot].label, display: formatSlot(profile, slot) })),
    corrections: [
      ...mergeResult.corrected.map(({ slot, from, to }) => ({ slot, label: slots[slot].label, from: slots[slot].format(from), to: slots[slot].format(to) })),
      ...mergeResult.invalidated.map(slot => ({ slot, label: slots[slot].label,
        from: profile.slots[slot].previousValue === undefined ? '不确定' : slots[slot].format(profile.slots[slot].previousValue), to: '待了解' })),
    ],
    notices, questions: nextQuestions.slice(0, 2), progress,
  };
}

export function renderReplyText(payload: ReplyPayload): string {
  const paragraphs: string[] = [];
  for (const notice of payload.notices) {
    paragraphs.push(notice.text);
    if (notice.conditions) paragraphs.push(notice.conditions.map(condition => `${condition.label}：${condition.display ?? (condition.known ? '已了解' : '待了解')}`).join('；'));
    if (notice.kind === 'professional') paragraphs.push('生成的计划会把这些列为需要持牌专业人士确认的事项。');
  }
  if (payload.recorded.length) paragraphs.push(`已记录：${payload.recorded.map(item => `${item.label} ${item.display}`).join('；')}`);
  for (const correction of payload.corrections) {
    const reason = correction.to === '待了解' && correction.slot in invalidationReasons
      ? invalidationReasons[correction.slot as keyof typeof invalidationReasons] : null;
    paragraphs.push(reason ?? `已更新：${correction.label} ${correction.from} → ${correction.to}`);
  }
  if (payload.questions.length) paragraphs.push(`还需要了解：${payload.questions.map(question => question.text).join(' ')}`);
  return paragraphs.join('\n\n');
}
