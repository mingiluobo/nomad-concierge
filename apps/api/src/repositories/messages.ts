import type { UserPayload } from '@nomad/shared';
import type { AppDatabase } from '../db/database.js';

export interface MessageRow { id: string; conversation_id: string; seq: number; role: 'user' | 'assistant'; content: string; payload_json: string | null; client_message_id: string | null; turn_id: string | null; consumed_by_turn_id: string | null; created_at: string }
export class MessagesRepository {
  constructor(private readonly db: AppDatabase) {}
  byClientId(conversationId: string, clientId: string): MessageRow | undefined { return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND client_message_id = ?').get<MessageRow>(conversationId, clientId); }
  insert(id: string, conversationId: string, seq: number, content: string, clientId: string, payload: UserPayload | undefined, now: string): void {
    this.db.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, payload_json, client_message_id, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)")
      .run(id, conversationId, seq, content, payload ? JSON.stringify(payload) : null, clientId, now);
  }
  page(conversationId: string, before: number | undefined, limit: number): MessageRow[] {
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?').all<MessageRow>(conversationId, before, before, limit);
  }
  unprocessedCount(conversationId: string): number {
    return this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND role = 'user' AND consumed_by_turn_id IS NULL").get<{ count: number }>(conversationId)!.count;
  }
}
