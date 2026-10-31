import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

export class AppDatabase {
  private readonly connection: Database.Database;

  constructor(filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(resolve(filename)), { recursive: true });
    }

    this.connection = new Database(filename);
    this.connection.pragma('foreign_keys = ON');

    if (filename !== ':memory:') {
      this.connection.pragma('journal_mode = WAL');
    }

    this.runStarterMigration();
  }

  ping(): boolean {
    const result = this.connection.prepare('SELECT 1 AS ok').get() as
      | { ok: number }
      | undefined;

    return result?.ok === 1;
  }

  close(): void {
    this.connection.close();
  }

  private runStarterMigration(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
}
