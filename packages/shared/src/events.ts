import { z } from 'zod';
import { conversationDetailDtoSchema, messageDtoSchema, turnDtoSchema, planSummaryDtoSchema, readStateSchema } from './dto.js';

export const eventPayloadSchemas = {
  'conversation.upserted': z.object({ conversation: conversationDetailDtoSchema }),
  'message.created': z.object({ message: messageDtoSchema }),
  'turn.upserted': z.object({ turn: turnDtoSchema }),
  'plan.created': z.object({ plan: planSummaryDtoSchema }),
  'read_state.updated': readStateSchema,
};
export type EventType = keyof typeof eventPayloadSchemas;
export type EventPayloadMap = { [K in EventType]: z.infer<(typeof eventPayloadSchemas)[K]> };
export type BusinessEvent = { [K in EventType]: { type: 'event'; id: number; eventType: K; conversationId?: string; payload: EventPayloadMap[K]; createdAt: string } }[EventType];
export const clientMessageSchema = z.object({ type: z.literal('resume'), lastEventId: z.number().int().nonnegative().nullable() });
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export const readyMessageSchema = z.object({ type: z.literal('ready'), latestEventId: z.number().int().nonnegative(), userId: z.string() });
export type ReadyMessage = z.infer<typeof readyMessageSchema>;
export const resyncRequiredSchema = z.object({ type: z.literal('resync_required') });
const eventBase = { type: z.literal('event'), id: z.number().int().positive(), conversationId: z.string().optional(), createdAt: z.string() };
export const businessEventSchema = z.discriminatedUnion('eventType', [
  z.object({ ...eventBase, eventType: z.literal('conversation.upserted'), payload: eventPayloadSchemas['conversation.upserted'] }),
  z.object({ ...eventBase, eventType: z.literal('message.created'), payload: eventPayloadSchemas['message.created'] }),
  z.object({ ...eventBase, eventType: z.literal('turn.upserted'), payload: eventPayloadSchemas['turn.upserted'] }),
  z.object({ ...eventBase, eventType: z.literal('plan.created'), payload: eventPayloadSchemas['plan.created'] }),
  z.object({ ...eventBase, eventType: z.literal('read_state.updated'), payload: eventPayloadSchemas['read_state.updated'] }),
]);
export const serverMessageSchema = z.union([readyMessageSchema, resyncRequiredSchema, businessEventSchema]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
