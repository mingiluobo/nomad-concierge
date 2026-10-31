import type { AppDatabase } from '../db/database.js';

export interface TokenRow { token_hash: string; user_id: string; created_at: string }
export class AuthTokensRepository {
  constructor(private readonly db: AppDatabase) {}
  get(hash: string): TokenRow | undefined { return this.db.prepare('SELECT token_hash, user_id, created_at FROM auth_tokens WHERE token_hash = ?').get<TokenRow>(hash); }
  insert(hash: string, userId: string, now: string): void { this.db.prepare('INSERT INTO auth_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)').run(hash, userId, now); }
  oldest(userId: string): TokenRow[] { return this.db.prepare('SELECT token_hash, user_id, created_at FROM auth_tokens WHERE user_id = ? ORDER BY created_at, rowid').all<TokenRow>(userId); }
  remove(hash: string): void { this.db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').run(hash); }
}
