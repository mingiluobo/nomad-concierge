import { messageDtoSchema, profileSchema, planContentSchema } from '@nomad/shared';
import type { ConversationDetailDto, ConversationSummaryDto, Goal, MessageDto, PlanDto, PlanSummaryDto } from '@nomad/shared';
import type { Domain } from '../composition.js';
import type { ConversationRow } from '../repositories/conversations.js';
import type { MessageRow } from '../repositories/messages.js';
import type { PlanRow } from '../repositories/plans.js';
import { householdSummary } from '../domain/title.js';

export function conversationSummary(row: ConversationRow): ConversationSummaryDto {
  return { id: row.id, title: row.title, status: row.status, enginePreference: row.engine_preference,
    lastSeq: row.last_seq, lastAssistantSeq: row.last_assistant_seq, messageCount: row.message_count,
    lastMessagePreview: row.last_message_preview, planId: row.plan_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function conversationDetail(row: ConversationRow, domain: Domain): ConversationDetailDto {
  const profile = profileSchema.parse(JSON.parse(row.profile_json));
  return { ...conversationSummary(row), profile, progress: domain.progress(profile) };
}
export function messageDto(row: MessageRow): MessageDto {
  return messageDtoSchema.parse({ id: row.id, conversationId: row.conversation_id, seq: row.seq, role: row.role, content: row.content,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null, clientMessageId: row.client_message_id, turnId: row.turn_id, createdAt: row.created_at });
}
export function planDto(row: PlanRow, conversation: ConversationRow): PlanDto {
  const content = planContentSchema.parse(JSON.parse(row.content_json));
  const profile = profileSchema.parse(JSON.parse(conversation.profile_json));
  return { id: row.id, conversationId: row.conversation_id, title: content.title, destination: content.destination, coverage: content.coverage,
    householdSummary: householdSummary(profile), goals: profile.slots.goals.value as Goal[], toConfirmCount: content.profileSummary.toConfirm.length, createdAt: row.created_at, content };
}
export function planSummary(plan: PlanDto): PlanSummaryDto {
  const { content: _content, ...summary } = plan;
  void _content;
  return summary;
}
