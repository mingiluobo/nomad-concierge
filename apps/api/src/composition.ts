import { createServer } from 'node:http';
import { errorCodeSchema } from '@nomad/shared';
import type { AssistantPayload, EngineId, EnginePreference, EngineStatus, EventPayloadMap, EventType, FailureReason, Interpretation, PlanContent, Profile, Progress, SlotKey, TurnDto } from '@nomad/shared';
import { createApp } from './app.js';
import type { AppConfig } from './config.js';
import { AppDatabase } from './db/database.js';
import { createDomain, transition } from './domain/index.js';
import { loadKnowledge } from './knowledge/loader.js';
import { createInterpreterFactory } from './agent/engines.js';
import { AuthenticationService } from './auth/service.js';
import { ConversationService } from './services/conversations.js';
import { createApiRouter } from './routes/api.js';
import { AppError, errorHandler } from './http/errors.js';
import { TurnsRepository } from './repositories/turns.js';
import { EventsRepository } from './repositories/events.js';
import { PersistentEventPublisher } from './realtime/publisher.js';
import { RealtimeServer } from './realtime/server.js';
import { TurnTaskService } from './turns/service.js';
import { TurnRunner } from './turns/runner.js';
import { createShutdown } from './lifecycle/shutdown.js';

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
  try {
    const domain = createDomain(loadKnowledge());
    const engines = createInterpreterFactory(config);
    const publisher = new PersistentEventPublisher(new EventsRepository(database));
    const turns = new TurnsRepository(database, domain, transition);
    const turnService = new TurnTaskService(database, turns, publisher,
      (code, status, message) => new AppError(errorCodeSchema.parse(code), status, message));
    const runner = new TurnRunner(database, turns, publisher, domain, engines, config);
    const auth = new AuthenticationService(database, {
      closeByTokenHash: (hashes, code) => realtime.closeByTokenHash(hashes, code),
    }, config);
    const conversations = new ConversationService(database, domain, turnService, publisher, turns, config);
    const router = createApiRouter({ auth, conversations, engines, config });
    const app = createApp({ database, webOrigins: config.webOrigins, router, errorHandler });
    const server = createServer(app);
    const realtime = new RealtimeServer(server, publisher, {
      webOrigins: config.webOrigins,
      serveWebDist: config.serveWebDist,
      authenticateToken: token => auth.authenticateToken(token),
    });
    const stopSystem = createShutdown({ server, realtime, runner, database });
    let engineStartup: Promise<void> | undefined;
    async function shutdown(): Promise<void> {
      engines.dispose();
      await stopSystem();
      await engineStartup;
    }
    async function start(): Promise<void> {
      // Local model discovery runs in the background; unavailable models fall back to rules.
      engineStartup = engines.start().catch((error: unknown) => {
        console.error('Engine startup failed', error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => { server.off('listening', listening); reject(error); };
          const listening = () => { server.off('error', failed); resolve(); };
          server.once('error', failed);
          server.once('listening', listening);
          server.listen(config.port);
        });
        // Recovery and the first claim are synchronous before the first request is handled.
        runner.start();
      } catch (error) {
        await shutdown();
        throw error;
      }
    }
    return { database, app, server, start, shutdown };
  } catch (error) {
    database.close();
    throw error;
  }
}
