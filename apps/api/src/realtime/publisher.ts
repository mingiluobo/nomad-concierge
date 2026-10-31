import type { EventPublisher, PendingEvent } from '../composition.js';
import type { AppDatabase } from '../db/database.js';
import type { EventsRepository } from '../repositories/events.js';
import type { StoredEvent } from '../repositories/events.js';

export class PersistentEventPublisher implements EventPublisher {
  private readonly listeners = new Set<(event: StoredEvent) => void>();
  constructor(readonly events: EventsRepository, private readonly now = () => new Date().toISOString()) {}
  append(tx: AppDatabase, event: PendingEvent): number { return this.events.append(tx, event, this.now()); }
  flush(eventIds: number[]): void {
    for (const id of [...new Set(eventIds)].sort((a, b) => a - b)) {
      const stored = this.events.get(id);
      if (stored) for (const listener of this.listeners) listener(stored);
    }
  }
  subscribe(listener: (event: StoredEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
