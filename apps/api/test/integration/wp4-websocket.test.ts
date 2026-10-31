import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendTurnEvent } from '../../src/turns/service.js';
import { controlledInterpreter, createHarness, result, socketHarness } from '../helpers/wp4.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function setup(options?: Parameters<typeof socketHarness>[1]) {
  const h = createHarness(); cleanup.push(h.close);
  const sockets = await socketHarness(h, options); cleanup.push(sockets.close);
  return { h, sockets };
}
function append(h: ReturnType<typeof createHarness>, count: number, userId = 'u'): number[] {
  const ids = h.database.transaction(tx => Array.from({ length: count }, (_, index) => h.publisher.append(tx, { userId, conversationId: 'c', type: 'read_state.updated', payload: { conversationId: 'c', lastReadSeq: index + 1 } })));
  h.publisher.flush(ids); return ids;
}
async function rejected(url: string, headers: Record<string, string>): Promise<number> {
  const socket = new WebSocket(url, { headers }); socket.on('error', () => {});
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!); socket.terminate(); });
    socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected successful upgrade')); });
  });
}
async function barrier(socket: WebSocket): Promise<void> { const pong = once(socket, 'pong'); socket.ping(); await pong; }

describe('WebSocket protocol and committed event delivery', () => {
  it('delivers a committed batch before events from a queued turn claimed by an earlier subscriber', async () => {
    const controlled = controlledInterpreter();
    // Constructing the harness registers the runner before the WebSocket listener.
    const h = createHarness({ interpreter: controlled.interpreter }); cleanup.push(h.close);
    const sockets = await socketHarness(h); cleanup.push(sockets.close);
    const client = await sockets.connect();
    client.socket.send(JSON.stringify({ type: 'resume', lastEventId: null }));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe('ready'));
    const conversationId = h.conversation();
    h.runner.start();
    const batchIds = h.database.transaction(tx => {
      const messageId = randomUUID(); const now = new Date().toISOString();
      tx.prepare('UPDATE conversations SET last_seq = 1, message_count = 1, version = version + 1 WHERE id = ?').run(conversationId);
      tx.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, client_message_id, created_at) VALUES (?, ?, 1, 'user', 'hello', ?, ?)")
        .run(messageId, conversationId, messageId, now);
      const { turn } = h.service.onUserMessage(tx, conversationId, messageId);
      const common = { userId: 'u', conversationId };
      return [appendTurnEvent(tx, h.turns, h.publisher, turn),
        h.publisher.append(tx, { ...common, type: 'conversation.upserted', payload: { conversation: h.turns.conversation(conversationId, tx)!.conversation } }),
        h.publisher.append(tx, { ...common, type: 'message.created', payload: { message: h.turns.unconsumed(conversationId, tx)[0]! } })];
    });
    h.publisher.flush(batchIds);
    await vi.waitFor(() => expect(controlled.calls).toHaveLength(1));
    controlled.calls[0]!.release(result());
    await h.runner.settled();
    // All writes are complete; pong follows their frames on this same connection.
    await barrier(client.socket);
    const events = client.messages.filter(message => message.type === 'event');
    const ids = events.map(event => event.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids.slice(0, batchIds.length)).toEqual(batchIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(events.slice(0, 4).map(event => event.eventType)).toEqual(['turn.upserted', 'conversation.upserted', 'message.created', 'turn.upserted']);
    expect(events[3]).toMatchObject({ payload: { turn: { status: 'running' } } });
    expect(events.some(event => event.eventType === 'turn.upserted' && event.payload.turn.status === 'completed')).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('validates cookies and Origin before upgrade, including same-origin production access', async () => {
    const { sockets } = await setup({ serveWebDist: true });
    expect(await rejected(sockets.url, { Origin: 'http://test.invalid' })).toBe(401);
    expect(await rejected(sockets.url, { Origin: 'http://test.invalid', Cookie: 'nc_token=invalid' })).toBe(401);
    expect(await rejected(sockets.url, { Origin: 'http://evil.invalid', Cookie: 'nc_token=valid' })).toBe(403);
    expect(await rejected(sockets.url, { Cookie: 'nc_token=valid' })).toBe(403);
    const client = await sockets.connect('valid', sockets.url.replace('ws://', 'http://').replace('/ws', ''));
    client.socket.send(JSON.stringify({ type: 'resume', lastEventId: null }));
    await vi.waitFor(() => expect(client.messages).toEqual([{ type: 'ready', latestEventId: 0, userId: 'u' }]));
  });

  it('first connection skips history but binds user identity and the global event cursor', async () => {
    const { h, sockets } = await setup(); append(h, 2); const otherIds = append(h, 1, 'other-user');
    const client = await sockets.connect();
    client.socket.send('{bad'); client.socket.send(JSON.stringify({ type: 'unknown' }));
    client.socket.send(JSON.stringify({ type: 'resume', lastEventId: null }));
    await vi.waitFor(() => expect(client.messages).toEqual([{ type: 'ready', latestEventId: otherIds[0], userId: 'u' }]));
    const next = append(h, 1)[0]; append(h, 1, 'other-user'); await barrier(client.socket);
    const events = client.messages.filter(message => message.type === 'event');
    expect(events.map(event => event.id)).toEqual([next]);
    expect(events[0]).toMatchObject({ eventType: 'read_state.updated', payload: { conversationId: 'c', lastReadSeq: 1 } });
  });

  it('replays only the authenticated user events in ascending order', async () => {
    const { h, sockets } = await setup(); const initial = append(h, 2); append(h, 2, 'other-user'); const later = append(h, 3);
    const client = await sockets.connect(); client.socket.send(JSON.stringify({ type: 'resume', lastEventId: initial[0] }));
    await vi.waitFor(() => expect(client.messages.at(-1)?.type).toBe('ready'));
    expect(client.messages.filter(message => message.type === 'event').map(event => event.id)).toEqual([initial[1], ...later]);
    expect(client.messages.at(-1)).toEqual({ type: 'ready', latestEventId: later.at(-1), userId: 'u' });
  });

  it('buffers events committed while replay is in progress and emits each once after ready', async () => {
    const { h, sockets } = await setup(); const existing = append(h, 600);
    const client = await sockets.connect(); let inserted: number | undefined;
    client.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'event' && inserted === undefined) inserted = append(h, 1)[0];
    });
    client.socket.send(JSON.stringify({ type: 'resume', lastEventId: 0 }));
    await vi.waitFor(() => expect(client.messages.filter(message => message.type === 'event')).toHaveLength(601));
    const events = client.messages.filter(message => message.type === 'event');
    expect(events.map(event => event.id)).toEqual([...existing, inserted]);
    const readyIndex = client.messages.findIndex(message => message.type === 'ready');
    const insertedIndex = client.messages.findIndex(message => message.type === 'event' && message.id === inserted);
    expect(readyIndex).toBeGreaterThanOrEqual(600); expect(insertedIndex).toBeGreaterThan(readyIndex);
    expect(new Set(events.map(event => event.id)).size).toBe(601);
  });

  it.each([1000, 1001])('uses resync_required only above the 1000-event replay boundary (%s)', async count => {
    const { h, sockets } = await setup(); const ids = append(h, count);
    const client = await sockets.connect(); client.socket.send(JSON.stringify({ type: 'resume', lastEventId: 0 }));
    await vi.waitFor(() => expect(client.messages.at(-1)?.type).toBe('ready'));
    if (count === 1000) {
      expect(client.messages.filter(message => message.type === 'event').map(event => event.id)).toEqual(ids);
      expect(client.messages.some(message => message.type === 'resync_required')).toBe(false);
    } else expect(client.messages).toEqual([{ type: 'resync_required' }, { type: 'ready', latestEventId: ids.at(-1), userId: 'u' }]);
  });

  it('closes every connection for a revoked token with 4401 and leaves other tokens live', async () => {
    const { h, sockets } = await setup(); const a = await sockets.connect(); const b = await sockets.connect(); const c = await sockets.connect('second');
    for (const client of [a, b, c]) client.socket.send(JSON.stringify({ type: 'resume', lastEventId: null }));
    await vi.waitFor(() => expect([a, b, c].every(client => client.messages.some(message => message.type === 'ready'))).toBe(true));
    const closed = [once(a.socket, 'close'), once(b.socket, 'close')];
    sockets.realtime.closeByTokenHash(['hash-valid'], 4401);
    const id = append(h, 1)[0];
    expect((await closed[0]!)[0]).toBe(4401); expect((await closed[1]!)[0]).toBe(4401);
    await barrier(c.socket);
    expect(a.messages.filter(message => message.type === 'event')).toEqual([]);
    expect(b.messages.filter(message => message.type === 'event')).toEqual([]);
    expect(c.messages.filter(message => message.type === 'event').map(event => event.id)).toEqual([id]);
    expect(c.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('does not broadcast an event whose transaction rolls back at beforeCommit', async () => {
    const { h, sockets } = await setup(); const client = await sockets.connect();
    client.socket.send(JSON.stringify({ type: 'resume', lastEventId: null }));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe('ready'));
    h.inject(() => { throw new Error('rollback before commit'); });
    expect(() => append(h, 1)).toThrow('rollback before commit'); h.inject();
    await barrier(client.socket);
    expect(h.events.latestId()).toBe(0);
    expect(client.messages.filter(message => message.type === 'event')).toEqual([]);
    const id = append(h, 1)[0]; await barrier(client.socket);
    expect(client.messages.filter(message => message.type === 'event').map(event => event.id)).toEqual([id]);
  });

  it('disconnects clients exceeding the frame limit and clients that miss two heartbeats', async () => {
    const { sockets } = await setup({ heartbeatMs: 30 }); const client = await sockets.connect();
    const oversizedClosed = once(client.socket, 'close'); client.socket.send('x'.repeat(4097)); await oversizedClosed;
    const silent = new WebSocket(sockets.url, { autoPong: false, headers: { Origin: 'http://test.invalid', Cookie: 'nc_token=valid' } });
    silent.on('error', () => {}); await once(silent, 'open');
    await once(silent, 'close'); expect(silent.readyState).toBe(WebSocket.CLOSED);
  });
});
