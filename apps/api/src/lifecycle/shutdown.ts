import type { Server } from 'node:http';
import type { AppDatabase } from '../db/database.js';
import type { RealtimeServer } from '../realtime/server.js';
import type { TurnRunner } from '../turns/runner.js';

export function createShutdown({ server, realtime, runner, database, forceExit = () => process.exit(1) }: {
  server: Server; realtime: RealtimeServer; runner: TurnRunner; database: AppDatabase; forceExit?: () => void;
}): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const deadline = setTimeout(forceExit, 10000);
      deadline.unref();
      try {
        realtime.stopAccepting();
        const httpClosed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        runner.dispose();
        await Promise.all([httpClosed, realtime.close(1012)]);
        database.close();
      } finally { clearTimeout(deadline); }
    })();
    return pending;
  };
}
