import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { migrations } from './migrations.js';
import type { Migration } from './migrations.js';

export type SqlParameter = SQLInputValue | boolean | undefined;
export interface RunResult { changes: number; lastInsertRowid: number | bigint }
export interface Statement {
  run(...parameters: SqlParameter[]): RunResult;
  get<T = Record<string, unknown>>(...parameters: SqlParameter[]): T | undefined;
  all<T = Record<string, unknown>>(...parameters: SqlParameter[]): T[];
}
export function sqlParameter(value: SqlParameter): SQLInputValue {
  return value === undefined ? null : typeof value === 'boolean' ? Number(value) : value;
}
export function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errcode' in error && (error.errcode === 2067 || error.errcode === 1555);
}
export interface DatabaseOptions { beforeCommit?: () => void }
export class AppDatabase {
  private readonly connection: DatabaseSync;
  private inTransaction = false;
  private readonly beforeCommit?: () => void;

  constructor(filename: string, options: DatabaseOptions = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
    this.connection = new DatabaseSync(filename);
    try {
      this.connection.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      if (filename !== ':memory:') this.connection.exec('PRAGMA journal_mode = WAL;');
      this.migrate();
      this.beforeCommit = options.beforeCommit;
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  exec(sql: string): void { this.connection.exec(sql); }

  prepare(sql: string): Statement {
    const statement = this.connection.prepare(sql);
    return {
      run: (...parameters) => {
        const result = statement.run(...parameters.map(sqlParameter));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      get: <T>(...parameters: SqlParameter[]) => statement.get(...parameters.map(sqlParameter)) as T | undefined,
      all: <T>(...parameters: SqlParameter[]) => statement.all(...parameters.map(sqlParameter)) as T[],
    };
  }

  transaction<T>(fn: (tx: AppDatabase) => T): T {
    if (this.inTransaction) throw new Error('Nested transactions are not supported');
    this.connection.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn(this);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        throw new TypeError('Transaction callbacks must be synchronous');
      }
      this.beforeCommit?.();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  migrate(available: readonly Migration[] = migrations): void {
    this.connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = this.prepare('SELECT MAX(version) AS version FROM schema_migrations').get<{ version: number | null }>()?.version ?? 0;
    const latest = available.at(-1)?.version ?? 0;
    if (current > latest) throw new Error(`Database schema version ${current} is newer than supported version ${latest}`);
    let previous = 0;
    for (const migration of available) {
      if (migration.version <= previous) throw new Error('Migration versions must be strictly increasing');
      previous = migration.version;
      if (migration.version <= current) continue;
      this.transaction(tx => {
        tx.exec(migration.sql);
        tx.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      });
    }
  }

  ping(): boolean { return this.prepare('SELECT 1 AS ok').get<{ ok: number }>()?.ok === 1; }
  close(): void { this.connection.close(); }
}
