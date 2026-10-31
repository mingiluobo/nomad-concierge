import WebSocket from 'ws';
import type { APIRequestContext } from '@playwright/test';
import { serverMessageSchema, type ServerMessage } from '../../packages/shared/src/events.js';

export async function cookieHeader(request: APIRequestContext): Promise<string> {
  const state = await request.storageState();
  return state.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

export interface SocketOptions { cookie?: string; origin?: string | null; autoPong?: boolean }
export interface SocketClose { code: number; reason: string }

/** Captures only protocol data; caller owns the lifetime of every connection. */
export class SocketProbe {
  readonly rawFrames: string[] = [];
  readonly messages: ServerMessage[] = [];
  readonly invalidMessages: string[] = [];
  readonly errors: string[] = [];
  readonly pingTimes: number[] = [];
  closed: SocketClose | undefined;
  private readonly observers = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.on('message', data => {
      const frame = data.toString();
      this.rawFrames.push(frame);
      try {
        this.messages.push(serverMessageSchema.parse(JSON.parse(frame)));
      } catch (error) {
        this.invalidMessages.push(String(error));
      }
      this.notify();
    });
    socket.on('ping', () => { this.pingTimes.push(Date.now()); this.notify(); });
    socket.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; this.notify(); });
    socket.on('error', error => { this.errors.push(error.message); this.notify(); });
  }

  static async connect(baseURL: string, options: SocketOptions = {}): Promise<SocketProbe> {
    const url = new URL('/ws', baseURL);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers: Record<string, string> = {};
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.origin !== null) headers.Origin = options.origin ?? new URL(baseURL).origin;
    const socket = new WebSocket(url, { headers, autoPong: options.autoPong ?? true, handshakeTimeout: 5_000 });
    const probe = new SocketProbe(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        socket.terminate();
        reject(new Error(`WebSocket upgrade returned HTTP ${response.statusCode}`));
      });
    });
    return probe;
  }

  resume(lastEventId: number | null): void {
    this.socket.send(JSON.stringify({ type: 'resume', lastEventId }));
  }

  async waitFor<T extends ServerMessage>(
    predicate: (message: ServerMessage) => message is T,
    options?: { after?: number; timeout?: number },
  ): Promise<T>;
  async waitFor(
    predicate: (message: ServerMessage) => boolean,
    options?: { after?: number; timeout?: number },
  ): Promise<ServerMessage>;
  async waitFor(predicate: (message: ServerMessage) => boolean, options = {} as { after?: number; timeout?: number }): Promise<ServerMessage> {
    let found: ServerMessage | undefined;
    await this.until(() => {
      found = this.messages.slice(options.after ?? 0).find(predicate);
      return found !== undefined;
    }, options.timeout ?? 10_000, 'protocol message');
    return found!;
  }

  waitReady(options?: { after?: number; timeout?: number }) {
    return this.waitFor((message): message is Extract<ServerMessage, { type: 'ready' }> => message.type === 'ready', options);
  }

  async waitClose(timeout = 5_000): Promise<SocketClose> {
    await this.until(() => this.closed !== undefined, timeout, 'connection close');
    return this.closed!;
  }

  async waitForPing(count: number, timeout = 30_000): Promise<void> {
    await this.until(() => this.pingTimes.length >= count, timeout, 'server ping');
  }

  /** A bounded negative-observation window, not a synchronization sleep. */
  async expectNoEvents(predicate: (message: ServerMessage) => boolean, durationMs = 500): Promise<void> {
    const after = this.messages.length;
    await new Promise<void>((resolve, reject) => {
      const observe = () => {
        if (this.messages.slice(after).some(predicate)) {
          clearTimeout(timer);
          this.observers.delete(observe);
          reject(new Error('Unexpected protocol message during negative-observation window'));
        }
      };
      const timer = setTimeout(() => { this.observers.delete(observe); resolve(); }, durationMs);
      this.observers.add(observe);
      observe();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.socket.close();
    try { await this.waitClose(1_000); } catch { this.socket.terminate(); await this.waitClose(1_000); }
  }

  private notify(): void { for (const observer of this.observers) observer(); }

  private async until(predicate: () => boolean, timeout: number, description: string): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const inspect = () => {
        if (predicate()) { clearTimeout(timer); this.observers.delete(inspect); resolve(); }
      };
      const timer = setTimeout(() => {
        this.observers.delete(inspect);
        reject(new Error(`Timed out waiting for ${description}; invalid messages: ${this.invalidMessages.join('; ')}`));
      }, timeout);
      this.observers.add(inspect);
      inspect();
    });
  }
}

export async function handshakeStatus(baseURL: string, options: SocketOptions): Promise<number> {
  const url = new URL('/ws', baseURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const headers: Record<string, string> = {};
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.origin !== null) headers.Origin = options.origin ?? new URL(baseURL).origin;
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 5_000 });
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once('open', () => { socket.close(); reject(new Error('Unexpected successful upgrade')); });
    socket.on('error', reject);
  });
}
