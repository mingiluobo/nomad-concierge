import type { ConversationStatus, EnginePreference, Profile } from '@nomad/shared';
import type { AppDatabase } from '../db/database.js';
import { transition } from '../domain/stateMachine.js';

export interface ConversationRow {
  id: string; user_id: string; title: string; status: ConversationStatus; engine_preference: EnginePreference;
  profile_json: string; last_seq: number; last_assistant_seq: number; message_count: number; last_message_preview: string | null;
  plan_id: string | null; create_client_id: string; version: number; created_at: string; updated_at: string;
}
export class ConversationsRepository {
  constructor(private readonly db: AppDatabase) {}
  get(id: string): ConversationRow | undefined { return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get<ConversationRow>(id); }
  byClientId(userId: string, clientId: string): ConversationRow | undefined { return this.db.prepare('SELECT * FROM conversations WHERE user_id = ? AND create_client_id = ?').get<ConversationRow>(userId, clientId); }
  list(userId: string, status?: ConversationStatus): ConversationRow[] {
    return this.db.prepare('SELECT * FROM conversations WHERE user_id = ? AND (? IS NULL OR status = ?) ORDER BY updated_at DESC, rowid DESC').all<ConversationRow>(userId, status, status);
  }
  count(userId: string): number { return this.db.prepare('SELECT COUNT(*) AS count FROM conversations WHERE user_id = ?').get<{ count: number }>(userId)!.count; }
  insert(id: string, userId: string, title: string, profile: Profile, clientId: string, preference: EnginePreference, now: string): void {
    this.db.prepare("INSERT INTO conversations (id, user_id, title, status, engine_preference, profile_json, create_client_id, created_at, updated_at) VALUES (?, ?, ?, 'collecting', ?, ?, ?, ?, ?)")
      .run(id, userId, title, preference, JSON.stringify(profile), clientId, now, now);
  }
  allocateMessage(id: string, content: string, now: string): number {
    return this.db.prepare('UPDATE conversations SET last_seq = last_seq + 1, message_count = message_count + 1, last_message_preview = ?, version = version + 1, updated_at = ? WHERE id = ? RETURNING last_seq')
      .get<{ last_seq: number }>(content.slice(0, 120), now, id)!.last_seq;
  }
  setPreference(id: string, preference: EnginePreference, now: string): void {
    this.db.prepare('UPDATE conversations SET engine_preference = ?, version = version + 1, updated_at = ? WHERE id = ?').run(preference, now, id);
  }
  complete(id: string, planId: string, now: string): boolean {
    const change = transition('collecting', 'completed');
    return this.db.prepare(`UPDATE conversations SET ${change.setSql}, plan_id = ?, updated_at = ? WHERE id = ? AND ${change.whereSql}`)
      .run(...change.setParameters, planId, now, id, ...change.whereParameters).changes === 1;
  }
}
