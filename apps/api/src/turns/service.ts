import type { TurnDto } from '@nomad/shared';
import type { EventPublisher, TurnService } from '../composition.js';
import type { AppDatabase } from '../db/database.js';
import type { TurnsRepository } from '../repositories/turns.js';

export type TurnErrorFactory = (code: string, status: number, message: string) => Error;
const defaultError: TurnErrorFactory = (code, status, message) => Object.assign(new Error(message), { code, status, httpStatus: status });
export function appendTurnEvent(tx: AppDatabase, turns: TurnsRepository, publisher: EventPublisher, turn: TurnDto): number {
  const owner = turns.conversation(turn.conversationId, tx);
  if (!owner) throw new Error('Turn conversation is missing');
  return publisher.append(tx, { userId: owner.userId, conversationId: turn.conversationId, type: 'turn.upserted', payload: { turn } });
}
export class TurnTaskService implements TurnService {
  constructor(private readonly database: AppDatabase, private readonly turns: TurnsRepository, private readonly publisher: EventPublisher, private readonly error: TurnErrorFactory = defaultError) {}
  onUserMessage(tx: AppDatabase, conversationId: string, newMessageId: string): { turn: TurnDto; superseded?: TurnDto } {
    const owner = this.turns.conversation(conversationId, tx);
    if (!owner || !this.turns.unconsumed(conversationId, tx).some(message => message.id === newMessageId)) throw this.error('NOT_FOUND', 404, '找不到消息。');
    const current = this.turns.active(conversationId, tx);
    const now = new Date().toISOString();
    const superseded = current ? this.turns.transition(tx, current.id, current.status, 'superseded', now) : null;
    return { turn: this.turns.create(tx, conversationId, owner.conversation.enginePreference, now), ...(superseded ? { superseded } : {}) };
  }
  cancel(conversationId: string, turnId: string): TurnDto {
    const eventIds: number[] = [];
    const turn = this.database.transaction(tx => {
      const current = this.turns.get(turnId, tx)?.turn;
      if (!current || current.conversationId !== conversationId) throw this.error('NOT_FOUND', 404, '找不到回复任务。');
      if (current.status !== 'queued' && current.status !== 'running') return current;
      const cancelled = this.turns.transition(tx, turnId, current.status, 'cancelled', new Date().toISOString())!;
      eventIds.push(appendTurnEvent(tx, this.turns, this.publisher, cancelled));
      return cancelled;
    });
    this.publisher.flush(eventIds);
    return turn;
  }
  retry(conversationId: string, turnId: string): { turn: TurnDto; created: boolean } {
    const eventIds: number[] = [];
    const result = this.database.transaction(tx => {
      const target = this.turns.get(turnId, tx)?.turn;
      const owner = this.turns.conversation(conversationId, tx);
      if (!target || target.conversationId !== conversationId || !owner) throw this.error('NOT_FOUND', 404, '找不到回复任务。');
      const active = this.turns.active(conversationId, tx);
      if (active) return { turn: active, created: false };
      if (owner.conversation.status !== 'collecting' || this.turns.latest(conversationId, tx)?.id !== target.id || !['failed', 'cancelled'].includes(target.status)) {
        throw this.error('TURN_NOT_RETRYABLE', 409, '只能重试最新的失败或中断任务。');
      }
      const turn = this.turns.create(tx, conversationId, owner.conversation.enginePreference, new Date().toISOString(), turnId);
      eventIds.push(appendTurnEvent(tx, this.turns, this.publisher, turn));
      return { turn, created: true };
    });
    this.publisher.flush(eventIds);
    return result;
  }
  activeTurn(conversationId: string): TurnDto | null { return this.turns.active(conversationId); }
}
