import type { BusinessEvent } from '@nomad/shared';
import type { PendingEvent } from '../composition.js';
import type { AppDatabase } from '../db/database.js';

interface EventRow { id: number; user_id: string; conversation_id: string | null; type: BusinessEvent['eventType']; payload_json: string; created_at: string }
export interface StoredEvent { userId: string; event: BusinessEvent }
function mapEvent(row: EventRow): StoredEvent {
  return { userId: row.user_id, event: { type: 'event', id: row.id, eventType: row.type,
    ...(row.conversation_id === null ? {} : { conversationId: row.conversation_id }),
    payload: JSON.parse(row.payload_json), createdAt: row.created_at } as BusinessEvent };
}
export class EventsRepository {
  constructor(private readonly database: AppDatabase) {}
  append(tx: AppDatabase, event: PendingEvent, now: string): number {
    return Number(tx.prepare('INSERT INTO events (user_id, conversation_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(event.userId, event.conversationId, event.type, JSON.stringify(event.payload), now).lastInsertRowid);
  }
  get(id: number): StoredEvent | undefined {
    const row = this.database.prepare('SELECT * FROM events WHERE id = ?').get<EventRow>(id);
    return row && mapEvent(row);
  }
  latestId(): number { return this.database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get<{ id: number }>()!.id; }
  after(userId: string, cursor: number, through: number, limit = 1001): StoredEvent[] {
    return this.database.prepare('SELECT * FROM events WHERE user_id = ? AND id > ? AND id <= ? ORDER BY id ASC LIMIT ?')
      .all<EventRow>(userId, cursor, through, limit).map(mapEvent);
  }
}
