import { createServer } from 'node:http';
import type { AssistantPayload, EngineId, EnginePreference, EngineStatus, EventPayloadMap, EventType, FailureReason, Interpretation, PlanContent, Profile, Progress, SlotKey, TurnDto } from '@nomad/shared';
import { createApp } from './app.js';
import type { AppConfig } from './config.js';
import { AppDatabase } from './db/database.js';

export interface TurnService {
  onUserMessage(tx: AppDatabase, conversationId: string, newMessageId: string): { turn: TurnDto; superseded?: TurnDto };
  cancel(conversationId: string, turnId: string): TurnDto;
  retry(conversationId: string, turnId: string): { turn: TurnDto; created: boolean };
  activeTurn(conversationId: string): TurnDto | null;
}
export type PendingEvent = { [K in EventType]: { userId: string; conversationId?: string; type: K; payload: EventPayloadMap[K] } }[EventType];
export interface EventPublisher { append(tx: AppDatabase, event: PendingEvent): number; flush(eventIds: number[]): void }
export interface ConnectionRegistry { closeByTokenHash(tokenHashes: string[], code: 4401): void }
export interface InterpretInput {
  newMessages: { id: string; content: string }[];
  profile: Profile;
  pendingSlots: SlotKey[];
  recentMessages: { role: 'user' | 'assistant'; content: string }[];
}
export interface InterpretResult {
  interpretation: Interpretation;
  engineUsed: EngineId;
  fallbacks: { engine: EngineId; reason: FailureReason }[];
  promptVersion?: string;
  droppedUpdates: { slot: string; reason: string }[];
}
export interface Interpreter { readonly id: EngineId | 'chain'; interpret(input: InterpretInput, signal: AbortSignal): Promise<InterpretResult> }
export interface InterpreterFactory { forPreference(preference: EnginePreference): Interpreter; status(): EngineStatus[] }
export interface MergeResult {
  profile: Profile;
  recorded: SlotKey[];
  corrected: { slot: SlotKey; from: unknown; to: unknown }[];
  invalidated: SlotKey[];
  droppedUpdates: { slot: string; reason: string }[];
  providedSlots: SlotKey[];
}
export interface ReplyInput {
  mergeResult: MergeResult;
  interpretation: Interpretation | null;
  progress: Progress;
  nextQuestions: AssistantPayload['questions'];
  destinationChanged: boolean;
}
export interface Domain {
  mergeInterpretation(profile: Profile, interpretation: Interpretation, sourceMessageId: string, now: string): MergeResult;
  reconcile(before: Profile, after: Profile, providedSlots: readonly SlotKey[]): MergeResult;
  progress(profile: Profile): Progress;
  nextQuestions(profile: Profile): AssistantPayload['questions'];
  composeReply(input: ReplyInput): Omit<AssistantPayload, 'process'>;
  renderReplyText(payload: Omit<AssistantPayload, 'process'>): string;
  generateTitle(profile: Profile): string;
  generatePlan(profile: Profile, now: string, generatedEarly: boolean): PlanContent;
}
export function createComposition(config: AppConfig) {
  const database = new AppDatabase(config.databasePath);
  const app = createApp({ database, webOrigins: config.webOrigins });
  const server = createServer(app);
  return { database, app, server };
}
