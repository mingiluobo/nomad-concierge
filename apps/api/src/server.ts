import { loadConfig } from './config.js';
import { createComposition } from './composition.js';

if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';
try {
  const application = createComposition(loadConfig());
  const shutDown = (): void => {
    void application.shutdown().catch((error: unknown) => {
      console.error('Shutdown failed', error);
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', shutDown);
  process.on('SIGTERM', shutDown);
  await application.start();
  const address = application.server.address();
  if (typeof address === 'object' && address) {
    console.log(`Nomad Concierge API listening on http://localhost:${address.port}`);
  }
} catch (error) {
  console.error('Application startup failed', error);
  process.exitCode = 1;
}
