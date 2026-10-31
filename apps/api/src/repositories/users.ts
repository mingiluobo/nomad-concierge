import type { UserDto } from '@nomad/shared';
import type { AppDatabase } from '../db/database.js';

export class UsersRepository {
  constructor(private readonly db: AppDatabase) {}
  byKey(key: string): UserDto | undefined { return this.db.prepare('SELECT id, username FROM users WHERE username_key = ?').get<UserDto>(key); }
  get(id: string): UserDto | undefined { return this.db.prepare('SELECT id, username FROM users WHERE id = ?').get<UserDto>(id); }
  insert(id: string, username: string, now: string): void {
    this.db.prepare('INSERT INTO users (id, username, username_key, created_at) VALUES (?, ?, ?, ?)').run(id, username, username.toLowerCase(), now);
  }
}
