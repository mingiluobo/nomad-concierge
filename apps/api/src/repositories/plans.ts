import type { PlanContent } from '@nomad/shared';
import type { AppDatabase } from '../db/database.js';

export interface PlanRow { id: string; conversation_id: string; user_id: string; content_json: string; created_at: string }
export class PlansRepository {
  constructor(private readonly db: AppDatabase) {}
  get(id: string): PlanRow | undefined { return this.db.prepare('SELECT * FROM plans WHERE id = ?').get<PlanRow>(id); }
  forConversation(conversationId: string): PlanRow | undefined { return this.db.prepare('SELECT * FROM plans WHERE conversation_id = ?').get<PlanRow>(conversationId); }
  list(userId: string): PlanRow[] { return this.db.prepare('SELECT * FROM plans WHERE user_id = ? ORDER BY created_at DESC, rowid DESC').all<PlanRow>(userId); }
  insert(id: string, conversationId: string, userId: string, content: PlanContent, now: string): void {
    this.db.prepare('INSERT INTO plans (id, conversation_id, user_id, content_json, created_at) VALUES (?, ?, ?, ?, ?)').run(id, conversationId, userId, JSON.stringify(content), now);
  }
}
