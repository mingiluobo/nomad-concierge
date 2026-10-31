import process from 'node:process';
import { createServer } from 'node:http';
import { inspect } from 'node:util';

// A QA-owned process with only a health endpoint. It does not load any product code.
const mode = process.env.QA_PORT_CHECK_MODE ?? 'ready';
if (mode === 'ordinary-exit') {
  process.stderr.write('QA controlled startup failure: configuration rejected\n');
  process.exit(23);
}
const server = createServer((_request, response) => {
  response.writeHead(mode === 'unhealthy' ? 503 : 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ owner: 'qa-fake-child', pid: process.pid, port: Number(process.env.PORT), origin: process.env.WEB_ORIGIN }));
});
server.once('error', error => {
  // Preserve the real Node listen error, including code, syscall and bound port.
  process.stderr.write(`${inspect(error)}\n`);
  process.exitCode = 1;
});
server.listen(Number(process.env.QA_PORT_CHECK_BIND_PORT ?? process.env.PORT));
process.once('SIGTERM', () => { server.closeAllConnections(); server.close(); });
