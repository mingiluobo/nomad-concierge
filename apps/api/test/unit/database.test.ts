import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase, isUniqueConstraintError } from '../../src/db/database.js';

const resources: (() => void)[] = [];
afterEach(() => { while (resources.length) resources.pop()?.(); });
function database(options?: ConstructorParameters<typeof AppDatabase>[1]) {
  const db = new AppDatabase(':memory:', options);
  resources.push(() => db.close());
  return db;
}

describe('SQLite foundation', () => {
  it('applies migrations once, enables foreign keys and configures busy timeout', () => {
    const db = database();
    db.migrate();
    db.migrate();
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>().map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining(['users', 'auth_tokens', 'conversations', 'messages', 'turns', 'plans', 'read_states', 'events']));
    expect(() => db.prepare('INSERT INTO auth_tokens VALUES (?, ?, ?)').run('t', 'missing', 'now')).toThrow();
  });

  it('converts booleans and undefined for every prepared-statement method', () => {
    const db = database();
    db.exec('CREATE TABLE values_test (flag INTEGER, missing TEXT)');
    db.prepare('INSERT INTO values_test VALUES (?, ?)').run(true, undefined);
    expect(db.prepare('SELECT * FROM values_test WHERE flag = ?').get(true)).toEqual({ flag: 1, missing: null });
    expect(db.prepare('SELECT * FROM values_test WHERE missing IS ?').all(undefined)).toEqual([{ flag: 1, missing: null }]);
    expect(db.prepare('SELECT ? AS flag').get(false)).toEqual({ flag: 0 });
  });

  it('commits synchronous work and rolls back all writes after an exception', () => {
    const db = database();
    db.exec('CREATE TABLE values_test (value TEXT)');
    expect(db.transaction(tx => { tx.prepare('INSERT INTO values_test VALUES (?)').run('kept'); return 7; })).toBe(7);
    expect(() => db.transaction(tx => { tx.prepare('INSERT INTO values_test VALUES (?)').run('discarded'); throw new Error('failure'); })).toThrow('failure');
    expect(db.prepare('SELECT * FROM values_test').all()).toEqual([{ value: 'kept' }]);
  });

  it('runs beforeCommit inside the transaction and rolls back every write when it fails', () => {
    const db = database({ beforeCommit: () => { throw new Error('injected failure'); } });
    expect(() => db.transaction(tx => {
      tx.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u', 'Alice', 'alice', 'now');
      tx.prepare('INSERT INTO events (user_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)').run('u', 'conversation.upserted', '{}', 'now');
    })).toThrow('injected failure');
    expect(db.prepare('SELECT * FROM users').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM events').all()).toEqual([]);
  });

  it('rejects nested and asynchronous transactions without leaving a transaction open', () => {
    const db = database();
    expect(() => db.transaction(tx => tx.transaction(() => 1))).toThrow('Nested');
    expect(() => db.transaction(async () => 1)).toThrow('synchronous');
    expect(db.transaction(() => 2)).toBe(2);
  });

  it('detects unique and primary-key conflicts by SQLite error code', () => {
    const db = database();
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u', 'Alice', 'alice', 'now');
    for (const values of [['v', 'ALICE', 'alice'], ['u', 'Bob', 'bob']]) {
      let error: unknown;
      try { db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(...values, 'now'); } catch (caught) { error = caught; }
      expect(isUniqueConstraintError(error)).toBe(true);
    }
    expect(isUniqueConstraintError(new Error('UNIQUE constraint failed'))).toBe(false);
  });

  it('preserves file data, enables WAL and refuses a database from a newer schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-db-'));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite');
    const first = new AppDatabase(path);
    expect(first.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    first.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u', 'Alice', 'alice', 'now');
    first.close();
    const second = new AppDatabase(path);
    expect(second.prepare('SELECT username FROM users').get()).toEqual({ username: 'Alice' });
    second.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(2, 'now');
    second.close();
    expect(() => new AppDatabase(path)).toThrow('Database schema version 2 is newer than supported version 1');
  });
});
