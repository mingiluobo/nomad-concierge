import { z } from 'zod';

export const conversationStatuses = ['collecting', 'completed'] as const;
export const turnStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled', 'superseded'] as const;
export const turnStages = ['queued', 'understanding', 'deciding', 'replying', 'done'] as const;
export const engineIds = ['remote', 'local', 'rules'] as const;
export const enginePreferences = ['auto', ...engineIds] as const;
export const failureReasons = ['unavailable', 'timeout', 'invalid_output', 'circuit_open', 'error'] as const;
export const conversationStatusSchema = z.enum(conversationStatuses);
export const turnStatusSchema = z.enum(turnStatuses);
export const turnStageSchema = z.enum(turnStages);
export const engineIdSchema = z.enum(engineIds);
export const enginePreferenceSchema = z.enum(enginePreferences);
export const failureReasonSchema = z.enum(failureReasons);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type TurnStage = z.infer<typeof turnStageSchema>;
export type EngineId = z.infer<typeof engineIdSchema>;
export type EnginePreference = z.infer<typeof enginePreferenceSchema>;
export type FailureReason = z.infer<typeof failureReasonSchema>;

export const conversationTransitions: Record<ConversationStatus, readonly ConversationStatus[]> = {
  collecting: ['completed'], completed: [],
};
export const turnTransitions: Record<TurnStatus, readonly TurnStatus[]> = {
  queued: ['running', 'cancelled', 'superseded'],
  running: ['completed', 'failed', 'cancelled', 'superseded', 'queued'],
  completed: [], failed: [], cancelled: [], superseded: [],
};
export const slotTransitions = {
  missing: ['known', 'unsure'], unsure: ['known'], known: ['known', 'missing'],
} as const;
export const activeTurnStatuses: readonly TurnStatus[] = ['queued', 'running'];
export const terminalTurnStatuses: readonly TurnStatus[] = ['completed', 'failed', 'cancelled', 'superseded'];
