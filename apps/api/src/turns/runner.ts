import { setTimeout as delay } from 'node:timers/promises';
import { unsureValueSchema } from '@nomad/shared';
import type { AssistantPayload, Interpretation, MessageDto, TurnDto } from '@nomad/shared';
import type { Domain, Interpreter, InterpreterFactory, MergeResult } from '../composition.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/database.js';
import type { TurnsRepository } from '../repositories/turns.js';
import type { PersistentEventPublisher } from '../realtime/publisher.js';
import { appendTurnEvent } from './service.js';
import { recoverRunningTurns } from './recovery.js';

type RunnerConfig = Pick<AppConfig, 'turnConcurrency' | 'turnTimeoutMs' | 'demoDelayMs' | 'llmRecentMessages'>;
interface RunningTask { controller: AbortController; timer: ReturnType<typeof setTimeout>; promise?: Promise<void> }
function segments(messages: MessageDto[]): MessageDto[][] {
  const result: MessageDto[][] = [];
  for (const message of messages) {
    const last = result.at(-1);
    if (message.role === 'user' && message.payload?.answers) result.push([message]);
    else if (last?.[0]?.role === 'user' && !last[0].payload?.answers) last.push(message);
    else result.push([message]);
  }
  return result;
}
export class TurnRunner {
  private readonly running = new Map<string, RunningTask>();
  private readonly jobs = new Set<Promise<void>>();
  private polling?: ReturnType<typeof setInterval>;
  private started = false;
  private kicking = false;
  private generation = 0;
  private readonly unsubscribe: () => void;
  constructor(private readonly database: AppDatabase, private readonly turns: TurnsRepository, private readonly publisher: PersistentEventPublisher,
    private readonly domain: Domain, private readonly interpreters: InterpreterFactory, private readonly config: RunnerConfig,
    private readonly reportError: (error: unknown, turnId: string) => void = (error, turnId) => console.error('Turn failed', { turnId, error })) {
    this.unsubscribe = publisher.subscribe(({ event }) => {
      if (event.eventType !== 'turn.upserted') return;
      const turn = event.payload.turn;
      if (['superseded', 'cancelled', 'failed'].includes(turn.status)) this.abortAndRelease(turn.id);
      // Finish publishing this committed batch before claiming work that emits newer events.
      if (turn.status === 'queued') queueMicrotask(() => this.kick());
    });
  }
  start(): void {
    if (this.started) return;
    recoverRunningTurns(this.database, this.turns, this.publisher);
    this.started = true;
    this.polling = setInterval(() => this.kick(), 2000);
    this.polling.unref();
    this.kick();
  }
  kick(): void {
    if (!this.started || this.kicking) return;
    this.kicking = true;
    try {
      while (this.running.size < this.config.turnConcurrency) {
        const next = this.turns.queued(1)[0];
        if (!next) break;
        const claimed = this.database.transaction(tx => {
          const turn = this.turns.transition(tx, next.id, 'queued', 'running', new Date().toISOString());
          return turn ? { turn, eventId: appendTurnEvent(tx, this.turns, this.publisher, turn) } : null;
        });
        if (!claimed) continue;
        const controller = new AbortController();
        const task: RunningTask = { controller, timer: setTimeout(() => this.timeout(claimed.turn.id), this.config.turnTimeoutMs) };
        this.running.set(claimed.turn.id, task);
        this.publisher.flush([claimed.eventId]);
        const generation = this.generation;
        const job = this.execute(claimed.turn, controller, generation).finally(() => {
          clearTimeout(task.timer);
          if (this.running.get(claimed.turn.id) === task) this.running.delete(claimed.turn.id);
          this.jobs.delete(job);
          this.kick();
        });
        task.promise = job;
        this.jobs.add(job);
      }
    } finally { this.kicking = false; }
  }
  private abortAndRelease(turnId: string): void {
    const task = this.running.get(turnId);
    if (!task) return;
    task.controller.abort(new DOMException('Turn interrupted', 'AbortError'));
    clearTimeout(task.timer);
    this.running.delete(turnId);
    queueMicrotask(() => this.kick());
  }
  private timeout(turnId: string): void {
    if (!this.started) return;
    this.fail(turnId, 'TURN_TIMEOUT');
  }
  private fail(turnId: string, code: 'TURN_TIMEOUT' | 'INTERNAL_ERROR'): void {
    const ids = this.database.transaction(tx => {
      const turn = this.turns.transition(tx, turnId, 'running', 'failed', new Date().toISOString(), code);
      return turn ? [appendTurnEvent(tx, this.turns, this.publisher, turn)] : [];
    });
    this.publisher.flush(ids);
  }
  private advance(turnId: string, stage: 'deciding' | 'replying'): void {
    const ids = this.database.transaction(tx => {
      const turn = this.turns.stage(tx, turnId, stage);
      return turn ? [appendTurnEvent(tx, this.turns, this.publisher, turn)] : [];
    });
    this.publisher.flush(ids);
  }
  private async execute(turn: TurnDto, controller: AbortController, generation: number): Promise<void> {
    const start = Date.parse(turn.startedAt!);
    try {
      const stored = this.turns.get(turn.id)!;
      const original = this.turns.conversation(turn.conversationId)!.conversation.profile;
      const input = this.turns.input(stored);
      const recentMessages = this.turns.recent(turn.conversationId, this.config.llmRecentMessages);
      let interpreter: Interpreter | undefined;
      let merged: MergeResult = { profile: structuredClone(original), recorded: [], corrected: [], invalidated: [], droppedUpdates: [], providedSlots: [] };
      let interpretation: Interpretation | null = null;
      let engineUsed: TurnDto['engineUsed'] = null;
      const fallbacks: TurnDto['fallbacks'] = [];
      let promptVersion: string | null = null;
      for (const segment of segments(input)) {
        controller.signal.throwIfAborted();
        const first = segment[0]!;
        let current: Interpretation;
        if (first.role === 'user' && first.payload?.answers) {
          current = { intent: 'provide_info', updates: [], unsure: [] };
          for (const answer of first.payload.answers) {
            if (unsureValueSchema.safeParse(answer.value).success) current.unsure.push(answer.slot);
            else current.updates.push({ slot: answer.slot, value: answer.value });
          }
        } else {
          interpreter ??= this.interpreters.forPreference(turn.engineRequested);
          const result = await interpreter.interpret({ newMessages: segment.map(message => ({ id: message.id, content: message.content })),
            profile: merged.profile, pendingSlots: merged.profile.pendingSlots, recentMessages }, controller.signal);
          current = result.interpretation;
          interpretation = current;
          engineUsed = result.engineUsed;
          fallbacks.push(...result.fallbacks);
          promptVersion = result.promptVersion ?? null;
          merged.droppedUpdates.push(...result.droppedUpdates);
        }
        if (!this.started || this.generation !== generation) return;
        const update = this.domain.mergeInterpretation(merged.profile, current, segment.at(-1)!.id, new Date().toISOString());
        merged = { profile: update.profile, recorded: [...new Set([...merged.recorded, ...update.recorded])],
          corrected: [...merged.corrected, ...update.corrected], invalidated: [...new Set([...merged.invalidated, ...update.invalidated])],
          droppedUpdates: [...merged.droppedUpdates, ...update.droppedUpdates], providedSlots: [...new Set([...merged.providedSlots, ...update.providedSlots])] };
      }
      if (this.config.demoDelayMs) await delay(this.config.demoDelayMs, undefined, { signal: controller.signal });
      if (!this.started || this.generation !== generation) return;
      const understood = Date.now();
      this.advance(turn.id, 'deciding');
      const checked = this.domain.reconcile(original, merged.profile, merged.providedSlots);
      merged.profile = checked.profile;
      merged.invalidated = [...new Set([...merged.invalidated, ...checked.invalidated])];
      const progress = this.domain.progress(merged.profile);
      const questions = this.domain.nextQuestions(merged.profile);
      merged.profile.pendingSlots = questions.map(question => question.slot);
      const reply = this.domain.composeReply({ mergeResult: merged, interpretation, progress, nextQuestions: questions,
        destinationChanged: original.slots.destination.value !== merged.profile.slots.destination.value });
      const decided = Date.now();
      this.advance(turn.id, 'replying');
      const content = this.domain.renderReplyText(reply);
      const now = new Date().toISOString();
      const payload: AssistantPayload = { ...reply, process: { engineUsed, fallbacks, promptVersion, timings: {
        queuedMs: Math.max(0, start - Date.parse(turn.createdAt)), understandingMs: Math.max(0, understood - start),
        decidingMs: decided - understood, replyingMs: Date.now() - decided, totalMs: Date.now() - start,
      } } };
      const eventIds = this.database.transaction(tx => {
        const result = this.turns.complete(tx, turn, merged.profile, this.domain.generateTitle(merged.profile), content, payload, now);
        if (!result) return [];
        const common = { userId: result.conversation.userId, conversationId: turn.conversationId };
        return [this.publisher.append(tx, { ...common, type: 'turn.upserted', payload: { turn: result.turn } }),
          this.publisher.append(tx, { ...common, type: 'message.created', payload: { message: result.message } }),
          this.publisher.append(tx, { ...common, type: 'conversation.upserted', payload: { conversation: result.conversation.conversation } })];
      });
      this.publisher.flush(eventIds);
    } catch (error) {
      if (!this.started || this.generation !== generation || controller.signal.aborted) return;
      this.reportError(error, turn.id);
      this.fail(turn.id, 'INTERNAL_ERROR');
    }
  }
  suspend(): void {
    this.started = false;
    this.generation += 1;
    clearInterval(this.polling);
    const ids = this.database.transaction(tx => {
      const eventIds: number[] = [];
      for (const turn of this.turns.running()) {
        const queued = this.turns.transition(tx, turn.id, 'running', 'queued', new Date().toISOString());
        if (queued) eventIds.push(appendTurnEvent(tx, this.turns, this.publisher, queued));
      }
      return eventIds;
    });
    for (const id of this.running.keys()) this.abortAndRelease(id);
    this.publisher.flush(ids);
  }
  dispose(): void { this.suspend(); this.unsubscribe(); }
  async settled(): Promise<void> {
    // Let already-scheduled claims register their jobs before observing completion.
    await Promise.resolve();
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }
  activeCount(): number { return this.running.size; }
}
