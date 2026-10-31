import { z } from 'zod';
import { profileSchema, progressSchema, slotKeySchema } from './profile.js';
import { countryCodeSchema } from './countries.js';
import { slots, goalSchema, unsureValueSchema } from './slots.js';
import { planContentSchema } from './plan.js';
import { conversationStatusSchema, turnStatusSchema, turnStageSchema, enginePreferenceSchema, engineIdSchema, failureReasonSchema } from './states.js';

export const userDtoSchema = z.object({ id: z.string(), username: z.string() });
export type UserDto = z.infer<typeof userDtoSchema>;
export const fallbackSchema = z.object({ engine: engineIdSchema, reason: failureReasonSchema });
export const timingsSchema = z.object({
  queuedMs: z.number().nonnegative().optional(), understandingMs: z.number().nonnegative().optional(),
  decidingMs: z.number().nonnegative().optional(), replyingMs: z.number().nonnegative().optional(), totalMs: z.number().nonnegative().optional(),
});
export const turnDtoSchema = z.object({
  id: z.string(), conversationId: z.string(), status: turnStatusSchema, stage: turnStageSchema,
  engineRequested: enginePreferenceSchema, engineUsed: engineIdSchema.nullable(), fallbacks: z.array(fallbackSchema),
  errorCode: z.string().nullable(), timings: timingsSchema, promptVersion: z.string().nullable(), retryOfTurnId: z.string().nullable(),
  attempt: z.number().int().positive(), version: z.number().int().positive(), createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
export type TurnDto = z.infer<typeof turnDtoSchema>;
export interface StructuredAnswer { slot: z.infer<typeof slotKeySchema>; value: unknown; label: string }
export interface UserPayload { answers?: StructuredAnswer[]; answeringSlot?: z.infer<typeof slotKeySchema> }
export const structuredAnswerSchema = z.object({ slot: slotKeySchema, value: z.unknown(), label: z.string() }).superRefine((answer, context) => {
  if (!Object.hasOwn(answer, 'value')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'value is required' });
    return;
  }
  const definition = slots[answer.slot];
  if (unsureValueSchema.safeParse(answer.value).success) {
    return;
  } else if (!definition.valueSchema.safeParse(answer.value).success) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'Invalid slot value' });
  }
}) as z.ZodType<StructuredAnswer>;
export const userPayloadSchema: z.ZodType<UserPayload> = z.object({
  answers: z.array(structuredAnswerSchema).min(1).optional(), answeringSlot: slotKeySchema.optional(),
}).strict().superRefine((payload, context) => {
  if (payload.answers && payload.answeringSlot) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['answeringSlot'], message: 'A text answer hint cannot accompany structured answers' });
  }
});
export const assistantPayloadSchema = z.object({
  recorded: z.array(z.object({ slot: slotKeySchema, label: z.string(), display: z.string() })),
  corrections: z.array(z.object({ slot: slotKeySchema, label: z.string(), from: z.string(), to: z.string() })),
  notices: z.array(z.object({
    kind: z.enum(['off_topic', 'professional', 'not_understood', 'unsupported_destination', 'ready']), text: z.string(),
    conditions: z.array(z.object({ label: z.string(), known: z.boolean(), display: z.string().optional() })).optional(),
  })),
  questions: z.array(z.object({ slot: slotKeySchema, text: z.string(), options: z.array(z.object({ label: z.string(), value: z.unknown() })), allowUnsure: z.boolean() })).max(2),
  progress: progressSchema,
  process: z.object({ engineUsed: engineIdSchema.nullable(), fallbacks: z.array(fallbackSchema), timings: timingsSchema, promptVersion: z.string().nullable() }),
});
export type AssistantPayload = z.infer<typeof assistantPayloadSchema>;
const messageBase = {
  id: z.string(), conversationId: z.string(), seq: z.number().int().positive(), content: z.string(),
  clientMessageId: z.string().nullable(), turnId: z.string().nullable(), createdAt: z.string(),
};
export const messageDtoSchema = z.discriminatedUnion('role', [
  z.object({ ...messageBase, role: z.literal('user'), payload: userPayloadSchema.nullable() }),
  z.object({ ...messageBase, role: z.literal('assistant'), payload: assistantPayloadSchema.nullable() }),
]);
export type MessageDto = z.infer<typeof messageDtoSchema>;
export const conversationSummaryDtoSchema = z.object({
  id: z.string(), title: z.string(), status: conversationStatusSchema, enginePreference: enginePreferenceSchema,
  lastSeq: z.number().int().nonnegative(), lastAssistantSeq: z.number().int().nonnegative(), messageCount: z.number().int().nonnegative(),
  lastMessagePreview: z.string().nullable(), planId: z.string().nullable(), version: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(),
});
export type ConversationSummaryDto = z.infer<typeof conversationSummaryDtoSchema>;
export const conversationDetailDtoSchema = conversationSummaryDtoSchema.extend({ profile: profileSchema, progress: progressSchema });
export type ConversationDetailDto = z.infer<typeof conversationDetailDtoSchema>;
export const planSummaryDtoSchema = z.object({
  id: z.string(), conversationId: z.string(), title: z.string(), destination: countryCodeSchema, coverage: z.enum(['full', 'generic']),
  householdSummary: z.string(), goals: z.array(goalSchema), toConfirmCount: z.number().int().nonnegative(), createdAt: z.string(),
  generatedEarly: z.boolean().optional(), knownCount: z.number().int().nonnegative().optional(), unknownCount: z.number().int().nonnegative().optional(),
});
export type PlanSummaryDto = z.infer<typeof planSummaryDtoSchema>;
export const planDtoSchema = planSummaryDtoSchema.extend({ content: planContentSchema });
export type PlanDto = z.infer<typeof planDtoSchema>;
export const engineStatusSchema = z.object({
  id: engineIdSchema, available: z.boolean(), reason: z.enum(['not_configured', 'unreachable', 'model_missing', 'circuit_open']).optional(), model: z.string().optional(),
});
export type EngineStatus = z.infer<typeof engineStatusSchema>;
export const readStateSchema = z.object({ conversationId: z.string(), lastReadSeq: z.number().int().nonnegative() });
export type ReadState = z.infer<typeof readStateSchema>;

export const loginRequestSchema = z.object({ username: z.string().trim().min(2).max(32) });
export const runtimeLimitsSchema = z.object({
  messageChars: z.number().int().positive(),
  messagesPerConversation: z.number().int().min(2),
});
export type RuntimeLimits = z.infer<typeof runtimeLimitsSchema>;
export const loginResponseSchema = z.object({ user: userDtoSchema, limits: runtimeLimitsSchema.optional() });
export const meResponseSchema = loginResponseSchema;
export const enginesResponseSchema = z.object({ engines: z.array(engineStatusSchema) });
export const conversationListQuerySchema = z.object({ status: conversationStatusSchema.optional() });
export const conversationListResponseSchema = z.object({ items: z.array(conversationSummaryDtoSchema), readStates: z.array(readStateSchema), activeTurns: z.array(turnDtoSchema) });
export const createConversationRequestSchema = z.object({ content: z.string().trim().min(1), clientMessageId: z.string().min(1), enginePreference: enginePreferenceSchema.optional() });
export const createConversationResponseSchema = z.object({ conversation: conversationDetailDtoSchema, message: messageDtoSchema, turn: turnDtoSchema });
export const conversationResponseSchema = z.object({ conversation: conversationDetailDtoSchema, activeTurn: turnDtoSchema.nullable(), latestTurn: turnDtoSchema.nullable(), plan: planSummaryDtoSchema.nullable(), readState: z.object({ lastReadSeq: z.number().int().nonnegative() }) });
export const updateConversationRequestSchema = z.object({ enginePreference: enginePreferenceSchema });
export const updateConversationResponseSchema = z.object({ conversation: conversationDetailDtoSchema });
export const messagesQuerySchema = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
export const messagesResponseSchema = z.object({ items: z.array(messageDtoSchema), nextCursor: z.number().int().positive().nullable() });
export const postMessageRequestSchema = z.object({ content: z.string().trim(), clientMessageId: z.string().min(1), payload: userPayloadSchema.optional() }).superRefine((value, context) => {
  if (!value.content && !value.payload?.answers?.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'A message or structured answer is required' });
});
export const postMessageResponseSchema = z.object({ message: messageDtoSchema, turn: turnDtoSchema.nullable() });
export const turnResponseSchema = z.object({ turn: turnDtoSchema });
export const readRequestSchema = z.object({ seq: z.number().int().nonnegative() });
export const readResponseSchema = z.object({ lastReadSeq: z.number().int().nonnegative() });
export const generatePlanRequestSchema = z.object({ allowIncomplete: z.boolean().optional() });
export const planResponseSchema = z.object({ plan: planDtoSchema });
export const plansResponseSchema = z.object({ items: z.array(planSummaryDtoSchema) });
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;
export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;
