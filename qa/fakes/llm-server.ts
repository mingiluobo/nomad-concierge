import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { Socket } from 'node:net';

export type Behavior =
  | { kind: 'json'; value: unknown }
  | { kind: 'raw'; content: string }
  | { kind: 'http'; status: number }
  | { kind: 'delay'; ms: number; value?: unknown }
  | { kind: 'hang' };
export interface FakeRequest {
  method: string; path: string; headers: IncomingHttpHeaders; body: unknown; receivedAt: string;
}
const empty = { intent: 'provide_info', updates: [], unsure: [] };

/** No upstream requests: every response is controlled locally by a test. */
export class FakeLlmServer {
  readonly requests: FakeRequest[] = [];
  baseURL = '';
  private behavior: Behavior = { kind: 'json', value: empty };
  private models = ['qa-model'];
  private queue: Behavior[] = [];
  private server?: Server;
  private sockets = new Set<Socket>();
  private timers = new Set<NodeJS.Timeout>();

  setBehavior(behavior: Behavior): void { this.behavior = behavior; this.queue = []; }
  enqueue(...behaviors: Behavior[]): void { this.queue.push(...behaviors); }
  setModels(models: string[]): void { this.models = [...models]; }
  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      let body: unknown = raw;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* Preserve malformed requests for evidence. */ }
      this.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body, receivedAt: new Date().toISOString() });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: this.models.map(id => ({ id })) }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
      const behavior = this.queue.shift() ?? this.behavior;
      if (behavior.kind === 'hang') return;
      if (behavior.kind === 'http') { res.writeHead(behavior.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'QA controlled failure' })); return; }
      const respond = () => {
        if (res.destroyed) return;
        const content = behavior.kind === 'raw' ? behavior.content : JSON.stringify(behavior.value ?? empty);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      };
      if (behavior.kind === 'delay') {
        const timer = setTimeout(() => { this.timers.delete(timer); respond(); }, behavior.ms);
        this.timers.add(timer);
        res.on('close', () => { clearTimeout(timer); this.timers.delete(timer); });
      } else respond();
    });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Fake service has no TCP address');
    this.baseURL = `http://127.0.0.1:${address.port}/v1`;
  }
  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
