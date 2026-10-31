import { loadConfig } from './config.js';
import { createComposition } from './composition.js';

if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';
const config = loadConfig();
const { database, server } = createComposition(config);
server.listen(config.port, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`Nomad Concierge API listening on http://localhost:${port}`);
});
let isShuttingDown = false;
function shutDown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  server.close(() => { database.close(); process.exitCode = 0; });
}
process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);
