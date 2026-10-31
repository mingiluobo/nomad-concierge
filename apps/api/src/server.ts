import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AppDatabase } from './database.js';

const config = loadConfig();
const database = new AppDatabase(config.databasePath);
const app = createApp({ database, webOrigin: config.webOrigin });

const server = app.listen(config.port, () => {
  console.log(`Nomad Concierge API listening on http://localhost:${config.port}`);
});

let isShuttingDown = false;

function shutDown(signal: string): void {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);

  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutDown('SIGINT'));
process.on('SIGTERM', () => shutDown('SIGTERM'));

