import { randomUUID } from 'node:crypto';
import { messageDtoSchema } from '@nomad/shared';
import type { AssistantPayload, ConversationDetailDto, EnginePreference, MessageDto, Profile, TurnDto, TurnStage, TurnStatus } from '@nomad/shared';
import type { Domain } from '../composition.js';
import type { AppDatabase } from '../db/database.js';

interface TurnRow {
  id: string; conversation_id: string; status: TurnStatus; stage: TurnStage; input_message_ids_json: string;
  engine_requested: EnginePreference; engine_used: TurnDto['engineUsed']; fallbacks_json: string; timings_json: string;
  error_code: string | null; prompt_version: string | null; retry_of_turn_id: string | null; attempt: number; version: number;
  created_at: string; started_at: string | null; finished_at: string | null;
}
interface ConversationRow {
  id: string; user_id: string; title: string; status: 'collecting' | 'completed'; engine_preference: EnginePreference;
  profile_json: string; last_seq: number; last_assistant_seq: number; message_count: number; last_message_preview: string | null;
  plan_id: string | null; version: number; created_at: string; updated_at: string;
}
interface MessageRow { id: string; conversation_id: string; seq: number; role: 'user' | 'assistant'; content: string; payload_json: string | null; client_message_id: string | null; turn_id: string | null; created_at: string }
export interface StoredTurn { turn: TurnDto; inputMessageIds: string[] }
export interface TurnConversation { userId: string; conversation: ConversationDetailDto }
export type StateTransition = (from: TurnStatus, to: TurnStatus) => {
  setSql: string; setParameters: readonly unknown[]; whereSql: string; whereParameters: readonly unknown[];
};
function turnFromRow(row: TurnRow): StoredTurn {
  return { inputMessageIds: JSON.parse(row.input_message_ids_json), turn: {
    id: row.id, conversationId: row.conversation_id, status: row.status, stage: row.stage,
    engineRequested: row.engine_requested, engineUsed: row.engine_used, fallbacks: JSON.parse(row.fallbacks_json),
    timings: JSON.parse(row.timings_json), errorCode: row.error_code, promptVersion: row.prompt_version,
    retryOfTurnId: row.retry_of_turn_id, attempt: row.attempt, version: row.version, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at,
  } };
}
function messageFromRow(row: MessageRow): MessageDto {
  return messageDtoSchema.parse({ id: row.id, conversationId: row.conversation_id, seq: row.seq, role: row.role, content: row.content,
    payload: row.payload_json === null ? null : JSON.parse(row.payload_json), clientMessageId: row.client_message_id,
    turnId: row.turn_id, createdAt: row.created_at });
}

// A reply commits its turn, profile, message and consumption markers as one unit.
export class TurnsRepository {
  constructor(private readonly database: AppDatabase, private readonly domain: Pick<Domain, 'progress'>, private readonly stateTransition: StateTransition) {}
  get(id: string, tx = this.database): StoredTurn | undefined {
    const row = tx.prepare('SELECT * FROM turns WHERE id = ?').get<TurnRow>(id);
    return row && turnFromRow(row);
  }
  active(conversationId: string, tx = this.database): TurnDto | null {
    const row = tx.prepare("SELECT * FROM turns WHERE conversation_id = ? AND status IN ('queued', 'running')").get<TurnRow>(conversationId);
    return row ? turnFromRow(row).turn : null;
  }
  latest(conversationId: string, tx = this.database): TurnDto | null {
    const row = tx.prepare('SELECT * FROM turns WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get<TurnRow>(conversationId);
    return row ? turnFromRow(row).turn : null;
  }
  queued(limit: number): TurnDto[] {
    return this.database.prepare("SELECT * FROM turns WHERE status = 'queued' ORDER BY created_at, rowid LIMIT ?").all<TurnRow>(limit).map(row => turnFromRow(row).turn);
  }
  running(): TurnDto[] { return this.database.prepare("SELECT * FROM turns WHERE status = 'running' ORDER BY created_at, rowid").all<TurnRow>().map(row => turnFromRow(row).turn); }
  conversation(id: string, tx = this.database): TurnConversation | undefined {
    const row = tx.prepare('SELECT * FROM conversations WHERE id = ?').get<ConversationRow>(id);
    if (!row) return undefined;
    const profile = JSON.parse(row.profile_json) as Profile;
    return { userId: row.user_id, conversation: { id: row.id, title: row.title, status: row.status, enginePreference: row.engine_preference,
      profile, progress: this.domain.progress(profile), lastSeq: row.last_seq, lastAssistantSeq: row.last_assistant_seq,
      messageCount: row.message_count, lastMessagePreview: row.last_message_preview, planId: row.plan_id,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at } };
  }
  unconsumed(conversationId: string, tx = this.database): MessageDto[] {
    return tx.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'user' AND consumed_by_turn_id IS NULL ORDER BY seq").all<MessageRow>(conversationId).map(messageFromRow);
  }
  input(stored: StoredTurn): MessageDto[] {
    const ids = new Set(stored.inputMessageIds);
    return this.database.prepare("SELECT * FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY seq")
      .all<MessageRow>(stored.turn.conversationId).filter(row => ids.has(row.id)).map(messageFromRow);
  }
  recent(conversationId: string, limit: number): { role: 'user' | 'assistant'; content: string }[] {
    return this.database.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
      .all<{ role: 'user' | 'assistant'; content: string }>(conversationId, limit).reverse().map(row => ({ role: row.role, content: row.content }));
  }
  create(tx: AppDatabase, conversationId: string, preference: EnginePreference, now: string, retryOf?: string): TurnDto {
    const id = randomUUID();
    const input = this.unconsumed(conversationId, tx).map(message => message.id);
    tx.prepare("INSERT INTO turns (id, conversation_id, status, stage, input_message_ids_json, engine_requested, retry_of_turn_id, created_at) VALUES (?, ?, 'queued', 'queued', ?, ?, ?, ?)")
      .run(id, conversationId, JSON.stringify(input), preference, retryOf, now);
    return this.get(id, tx)!.turn;
  }
  transition(tx: AppDatabase, id: string, from: TurnStatus, to: TurnStatus, now: string, errorCode?: string): TurnDto | null {
    const change = this.stateTransition(from, to);
    const stage = to === 'running' ? 'understanding' : to === 'queued' ? 'queued' : 'done';
    const changes = tx.prepare(`UPDATE turns SET ${change.setSql}, stage = ?, started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END, finished_at = CASE WHEN ? IN ('queued', 'running') THEN NULL ELSE ? END, error_code = ? WHERE id = ? AND ${change.whereSql}`)
      .run(...change.setParameters as [TurnStatus], stage, to, now, to, now, errorCode, id, ...change.whereParameters as [TurnStatus]).changes;
    return changes ? this.get(id, tx)!.turn : null;
  }
  stage(tx: AppDatabase, id: string, stage: TurnStage): TurnDto | null {
    return tx.prepare("UPDATE turns SET stage = ?, version = version + 1 WHERE id = ? AND status = 'running'").run(stage, id).changes ? this.get(id, tx)!.turn : null;
  }
  incrementAttempt(tx: AppDatabase, id: string): TurnDto {
    tx.prepare('UPDATE turns SET attempt = attempt + 1 WHERE id = ?').run(id);
    return this.get(id, tx)!.turn;
  }
  complete(tx: AppDatabase, turn: TurnDto, profile: Profile, title: string, content: string, payload: AssistantPayload, now: string): { turn: TurnDto; message: MessageDto; conversation: TurnConversation } | null {
    const completed = this.transition(tx, turn.id, 'running', 'completed', now);
    if (!completed) return null;
    tx.prepare('UPDATE turns SET engine_used = ?, fallbacks_json = ?, timings_json = ?, prompt_version = ? WHERE id = ?')
      .run(payload.process.engineUsed, JSON.stringify(payload.process.fallbacks), JSON.stringify(payload.process.timings), payload.process.promptVersion, turn.id);
    const sequence = tx.prepare('UPDATE conversations SET profile_json = ?, title = ?, last_seq = last_seq + 1, last_assistant_seq = last_seq + 1, message_count = message_count + 1, last_message_preview = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = \'collecting\' RETURNING last_seq')
      .get<{ last_seq: number }>(JSON.stringify(profile), title, content.slice(0, 120), now, turn.conversationId);
    if (!sequence) throw new Error('Conversation is not collecting');
    const id = randomUUID();
    tx.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, payload_json, turn_id, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)")
      .run(id, turn.conversationId, sequence.last_seq, content, JSON.stringify(payload), turn.id, now);
    const input = this.get(turn.id, tx)!.inputMessageIds;
    for (const messageId of input) tx.prepare("UPDATE messages SET consumed_by_turn_id = ? WHERE id = ? AND conversation_id = ? AND role = 'user' AND consumed_by_turn_id IS NULL").run(turn.id, messageId, turn.conversationId);
    return { turn: this.get(turn.id, tx)!.turn, message: messageFromRow(tx.prepare('SELECT * FROM messages WHERE id = ?').get<MessageRow>(id)!), conversation: this.conversation(turn.conversationId, tx)! };
  }
}
