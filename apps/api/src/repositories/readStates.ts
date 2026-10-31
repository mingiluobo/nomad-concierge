import type { ReadState } from '@nomad/shared';
import type { AppDatabase } from '../db/database.js';

export class ReadStatesRepository {
  constructor(private readonly db: AppDatabase) {}
  get(userId: string, conversationId: string): number { return this.db.prepare('SELECT last_read_seq FROM read_states WHERE user_id = ? AND conversation_id = ?').get<{ last_read_seq: number }>(userId, conversationId)?.last_read_seq ?? 0; }
  list(userId: string): ReadState[] { return this.db.prepare('SELECT conversation_id AS conversationId, last_read_seq AS lastReadSeq FROM read_states WHERE user_id = ?').all<ReadState>(userId).map(row => ({ ...row })); }
  update(userId: string, conversationId: string, seq: number, now: string): number {
    return this.db.prepare('INSERT INTO read_states (user_id, conversation_id, last_read_seq, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, conversation_id) DO UPDATE SET last_read_seq = MAX(read_states.last_read_seq, excluded.last_read_seq), updated_at = excluded.updated_at RETURNING last_read_seq')
      .get<{ last_read_seq: number }>(userId, conversationId, seq, now)!.last_read_seq;
  }
}
