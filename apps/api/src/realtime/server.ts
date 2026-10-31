import { setImmediate as nextTurn } from 'node:timers/promises';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { clientMessageSchema } from '@nomad/shared';
import type { BusinessEvent, ServerMessage } from '@nomad/shared';
import type { ConnectionRegistry } from '../composition.js';
import type { StoredEvent } from '../repositories/events.js';
import type { PersistentEventPublisher } from './publisher.js';

export interface SocketIdentity { userId: string; tokenHash: string }
export interface RealtimeOptions {
  webOrigins: readonly string[];
  serveWebDist: boolean;
  authenticateToken: (token: string) => SocketIdentity | null;
  heartbeatMs?: number;
}
interface Client {
  socket: WebSocket; identity: SocketIdentity; authorized: boolean; mode: 'waiting' | 'replaying' | 'live';
  buffer: BusinessEvent[]; serial: number; missedPongs: number;
}
function tokenFromCookie(cookie: string | undefined): string | undefined {
  for (const item of (cookie ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (item.slice(0, separator).trim() === 'nc_token') {
      try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}
export class RealtimeServer implements ConnectionRegistry {
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private readonly clients = new Set<Client>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private accepting = true;
  constructor(private readonly server: Server, private readonly publisher: PersistentEventPublisher, private readonly options: RealtimeOptions) {
    server.on('upgrade', this.upgrade);
    this.unsubscribe = publisher.subscribe(stored => this.broadcast(stored));
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (client.missedPongs >= 2) { client.authorized = false; client.socket.terminate(); continue; }
        client.missedPongs += 1;
        if (client.socket.readyState === WebSocket.OPEN) client.socket.ping();
      }
    }, options.heartbeatMs ?? 25000);
    this.heartbeat.unref();
  }
  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const reject = (status: number, text: string): void => { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!this.accepting) { reject(503, 'Service Unavailable'); return; }
    if (request.url?.split('?')[0] !== '/ws') { reject(404, 'Not Found'); return; }
    const origin = request.headers.origin;
    const encrypted = 'encrypted' in request.socket && request.socket.encrypted;
    const sameOrigin = `${encrypted ? 'https' : 'http'}://${request.headers.host ?? ''}`;
    if (!origin || (!this.options.webOrigins.includes(origin) && !(this.options.serveWebDist && origin === sameOrigin))) { reject(403, 'Forbidden'); return; }
    const token = tokenFromCookie(request.headers.cookie);
    const identity = token ? this.options.authenticateToken(token) : null;
    if (!identity) { reject(401, 'Unauthorized'); return; }
    this.sockets.handleUpgrade(request, socket, head, webSocket => this.connected(webSocket, identity));
  };
  private connected(socket: WebSocket, identity: SocketIdentity): void {
    const client: Client = { socket, identity, authorized: true, mode: 'waiting', buffer: [], serial: 0, missedPongs: 0 };
    this.clients.add(client);
    socket.on('pong', () => { client.missedPongs = 0; });
    socket.on('close', () => { client.authorized = false; this.clients.delete(client); });
    socket.on('error', () => {
      client.authorized = false;
      // Protocol errors already initiate a close frame; preserve its code and handshake.
      if (socket.readyState !== WebSocket.CLOSING) socket.terminate();
    });
    socket.on('message', data => {
      if (!client.authorized) return;
      let raw: unknown;
      try { raw = JSON.parse(data.toString()); } catch { return; }
      const message = clientMessageSchema.safeParse(raw);
      if (!message.success) return;
      void this.resume(client, message.data.lastEventId).catch(() => { client.authorized = false; socket.close(1011, 'Synchronization failed'); });
    });
  }
  private send(client: Client, message: ServerMessage): boolean {
    if (!client.authorized || client.socket.readyState !== WebSocket.OPEN) return false;
    try {
      client.socket.send(JSON.stringify(message), error => { if (error) { client.authorized = false; client.socket.terminate(); } });
      return true;
    } catch { client.authorized = false; client.socket.terminate(); return false; }
  }
  private async resume(client: Client, lastEventId: number | null): Promise<void> {
    const serial = ++client.serial;
    client.mode = 'replaying';
    const latestEventId = this.publisher.events.latestId();
    let lastSent = latestEventId;
    if (lastEventId !== null) {
      const replay = this.publisher.events.after(client.identity.userId, lastEventId, latestEventId);
      if (replay.length > 1000) this.send(client, { type: 'resync_required' });
      else {
        lastSent = lastEventId;
        for (let index = 0; index < replay.length; index += 1) {
          if (!client.authorized || serial !== client.serial) return;
          const item = replay[index]!;
          if (!this.send(client, item.event)) return;
          lastSent = item.event.id;
          if (index % 100 === 99) await nextTurn();
        }
      }
    }
    if (!client.authorized || serial !== client.serial) return;
    if (!this.send(client, { type: 'ready', latestEventId, userId: client.identity.userId })) return;
    for (const event of client.buffer.sort((a, b) => a.id - b.id)) {
      if (event.id > lastSent && this.send(client, event)) lastSent = event.id;
    }
    client.buffer = [];
    client.mode = 'live';
  }
  private broadcast({ userId, event }: StoredEvent): void {
    for (const client of this.clients) {
      if (!client.authorized || client.identity.userId !== userId) continue;
      if (client.mode === 'live') this.send(client, event);
      else client.buffer.push(event);
    }
  }
  closeByTokenHash(tokenHashes: string[], code: 4401): void {
    const hashes = new Set(tokenHashes);
    for (const client of this.clients) if (hashes.has(client.identity.tokenHash)) {
      client.authorized = false;
      client.buffer = [];
      client.socket.close(code, 'Identity expired');
    }
  }
  stopAccepting(): void { this.accepting = false; }
  close(code = 1012): Promise<void> {
    this.stopAccepting();
    clearInterval(this.heartbeat);
    this.unsubscribe();
    this.server.off('upgrade', this.upgrade);
    for (const client of this.clients) { client.authorized = false; client.socket.close(code, 'Service restarting'); }
    return new Promise((resolve, reject) => this.sockets.close(error => error ? reject(error) : resolve()));
  }
}
