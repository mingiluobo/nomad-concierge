import { createEmptyProfile } from '@nomad/shared';
import type { ConversationDetailDto, MessageDto, PlanDto, TurnDto } from '@nomad/shared';

export const now = '2026-10-31T08:00:00.000Z';
export function conversation(version = 1): ConversationDetailDto {
  return { id: 'c', title: '葡萄牙 · 个人', status: 'collecting', enginePreference: 'rules', lastSeq: 2, lastAssistantSeq: 2, messageCount: 2, lastMessagePreview: '请补充国籍', planId: null, version, createdAt: now, updatedAt: now, profile: createEmptyProfile(), progress: { required: 8, answered: 0, missing: ['destination', 'goals', 'applicantNationality'], unsure: [], isComplete: false, canGenerateEarly: false } };
}
export function message(seq = 1, clientMessageId: string | null = null): MessageDto {
  return { id: `m${seq}`, conversationId: 'c', seq, role: 'user', content: `消息 ${seq}`, payload: null, clientMessageId, turnId: null, createdAt: now };
}
export function assistant(seq = 2): MessageDto {
  return { ...message(seq), role: 'assistant', turnId: 't', payload: { recorded: [], corrections: [], notices: [], questions: [{ slot: 'destination', text: '你打算去哪个国家？', options: [{ label: '葡萄牙', value: 'PT' }], allowUnsure: false }], progress: conversation().progress, process: { engineUsed: 'rules', fallbacks: [], timings: { totalMs: 20 }, promptVersion: null } } };
}
export function turn(version = 1, status: TurnDto['status'] = 'running'): TurnDto {
  return { id: 't', conversationId: 'c', status, stage: status === 'running' ? 'understanding' : 'done', engineRequested: 'rules', engineUsed: null, fallbacks: [], errorCode: null, timings: {}, promptVersion: null, retryOfTurnId: null, attempt: 1, version, createdAt: now, startedAt: now, finishedAt: status === 'running' ? null : now };
}
export function plan(): PlanDto {
  return { id: 'p', conversationId: 'c', title: '葡萄牙行动计划', destination: 'PT', coverage: 'full', householdSummary: '独自出发', goals: ['residence'], toConfirmCount: 1, createdAt: now, content: { schemaVersion: 1, title: '葡萄牙行动计划', destination: 'PT', coverage: 'full', generatedAt: now, generatedEarly: true, profileSummary: { known: [{ slot: 'destination', label: '目的国', display: '葡萄牙' }], unknown: [{ slot: 'timeline', label: '计划时间' }], toConfirm: [{ label: '居留类型', reason: '需要专业确认' }] }, firstStepId: 'passport', phases: [{ phase: 'before', label: '出发前', steps: [{ id: 'passport', goal: 'general', title: '确认护照有效期', why: '为后续准备建立基础', materials: ['护照'], dependsOn: [], needsProfessional: false }] }], professionalBoundary: [{ topic: '居留', conditions: ['本人国籍'], note: '请咨询持牌专业人士' }], sources: [{ label: '政府服务门户', note: '演示用途，未做时效核实' }], disclaimer: '不能替代持牌专业人士的意见' } };
}
