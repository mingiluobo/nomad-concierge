import type { EventPublisher } from '../composition.js';
import type { AppDatabase } from '../db/database.js';
import type { TurnsRepository } from '../repositories/turns.js';
import { appendTurnEvent } from './service.js';

export function recoverRunningTurns(database: AppDatabase, turns: TurnsRepository, publisher: EventPublisher): void {
  const eventIds = database.transaction(tx => {
    const ids: number[] = [];
    for (const running of turns.running()) {
      const restored = turns.incrementAttempt(tx, running.id);
      const now = new Date().toISOString();
      const turn = turns.transition(tx, restored.id, 'running', restored.attempt > 3 ? 'failed' : 'queued', now, restored.attempt > 3 ? 'RECOVERY_LIMIT' : undefined);
      if (turn) ids.push(appendTurnEvent(tx, turns, publisher, turn));
    }
    return ids;
  });
  publisher.flush(eventIds);
}
