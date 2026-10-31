import { once } from 'node:events';
import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';

export async function listenOnLoopback(handler: RequestListener): Promise<Server> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

export async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export function loopbackOrigin(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  // Match the listening family: a separate IPv4 listener can share an IPv6 port on macOS.
  const host = address.family === 'IPv6' ? '[::1]' : '127.0.0.1';
  return `http://${host}:${address.port}`;
}
