import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createEmptyProfile, slotKeys, slots } from '@nomad/shared';
import type { Interpretation, Profile, ServerMessage, UserPayload } from '@nomad/shared';
import type { Domain, Interpreter, InterpretInput, InterpretResult, MergeResult } from '../../src/composition.js';
import { AppDatabase } from '../../src/db/database.js';
import { TurnsRepository } from '../../src/repositories/turns.js';
import { EventsRepository } from '../../src/repositories/events.js';
import { PersistentEventPublisher } from '../../src/realtime/publisher.js';
import { TurnTaskService, appendTurnEvent } from '../../src/turns/service.js';
import { TurnRunner } from '../../src/turns/runner.js';
import { RealtimeServer } from '../../src/realtime/server.js';

export function result(interpretation: Partial<Interpretation> = {}): InterpretResult {
  return { interpretation: { intent: 'provide_info', updates: [], unsure: [], ...interpretation }, engineUsed: 'rules', fallbacks: [], droppedUpdates: [] };
}
export function controlledInterpreter() {
  const calls: { input: InterpretInput; signal: AbortSignal; release: (value: InterpretResult) => void; reject: (error: Error) => void }[] = [];
  const interpreter: Interpreter = { id: 'rules', interpret: (input, signal) => new Promise((release, reject) => { calls.push({ input: structuredClone(input), signal, release, reject }); }) };
  return { interpreter, calls };
}
export function fakeDomain(): Domain {
  const emptyMerge = (profile: Profile): MergeResult => ({ profile, recorded: [], corrected: [], invalidated: [], droppedUpdates: [], providedSlots: [] });
  const domain: Domain = {
    mergeInterpretation(profile, interpretation, sourceMessageId, now) {
      const merged = emptyMerge(structuredClone(profile));
      for (const update of interpretation.updates) {
        if (!slots[update.slot].valueSchema.safeParse(update.value).success) continue;
        merged.profile.slots[update.slot] = { status: 'known', value: update.value, sourceMessageId, updatedAt: now };
        merged.recorded.push(update.slot); merged.providedSlots.push(update.slot);
      }
      for (const key of interpretation.unsure) if (slots[key].allowUnsure && merged.profile.slots[key].status !== 'known') merged.profile.slots[key] = { status: 'unsure', sourceMessageId, updatedAt: now };
      return merged;
    },
    reconcile: (_before, after) => emptyMerge(after),
    progress(profile) {
      const missing = slotKeys.filter(key => profile.slots[key].status === 'missing');
      return { required: 15, answered: 15 - missing.length, missing, unsure: slotKeys.filter(key => profile.slots[key].status === 'unsure'), isComplete: !missing.length, canGenerateEarly: ['destination', 'goals', 'applicantNationality'].every(key => profile.slots[key as keyof Profile['slots']].status === 'known') };
    },
    nextQuestions: profile => profile.pendingSlots.filter(key => profile.slots[key].status === 'missing').slice(0, 2).map(slot => ({ slot, text: slots[slot].question, options: [], allowUnsure: slots[slot].allowUnsure })),
    composeReply: input => ({ recorded: input.mergeResult.recorded.map(slot => ({ slot, label: slots[slot].label, display: String(input.mergeResult.profile.slots[slot].value) })), corrections: [], notices: [], questions: input.nextQuestions, progress: input.progress }),
    renderReplyText: payload => `已处理：${payload.recorded.map(item => item.display).join('、')}`,
    generateTitle: () => '咨询',
    generatePlan: () => { throw new Error('Not used by turn tests'); },
  };
  return domain;
}
export function createHarness(options: { interpreter?: Interpreter; domain?: Domain; timeoutMs?: number; concurrency?: number; demoDelayMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nc-turns-'));
  const databasePath = join(directory, 'test.sqlite');
  let beforeCommit: (() => void) | undefined;
  const database = new AppDatabase(databasePath, { beforeCommit: () => beforeCommit?.() });
  const domain = options.domain ?? fakeDomain();
  const turns = new TurnsRepository(database, domain, (from, to) => ({ setSql: 'status = ?, version = version + 1', setParameters: [to], whereSql: 'status IN (?)', whereParameters: [from] }));
  const events = new EventsRepository(database);
  const publisher = new PersistentEventPublisher(events);
  const service = new TurnTaskService(database, turns, publisher);
  const interpreter = options.interpreter ?? { id: 'rules' as const, interpret: async () => result() };
  const errors: unknown[] = [];
  const interpreters = { forPreference: () => interpreter, status: () => [] };
  const runner = new TurnRunner(database, turns, publisher, domain, interpreters, {
    turnConcurrency: options.concurrency ?? 4, turnTimeoutMs: options.timeoutMs ?? 3000, demoDelayMs: options.demoDelayMs ?? 0, llmRecentMessages: 6,
  }, error => errors.push(error));
  database.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('u', 'Test User', 'test user', new Date().toISOString());
  function conversation(profile = createEmptyProfile()): string {
    const id = randomUUID(); const now = new Date().toISOString();
    database.prepare("INSERT INTO conversations (id, user_id, title, status, profile_json, create_client_id, created_at, updated_at) VALUES (?, 'u', '咨询', 'collecting', ?, ?, ?, ?)").run(id, JSON.stringify(profile), randomUUID(), now, now);
    return id;
  }
  function send(conversationId: string, content: string, payload?: UserPayload) {
    const ids: number[] = [];
    const value = database.transaction(tx => {
      const id = randomUUID(); const now = new Date().toISOString();
      const seq = tx.prepare('UPDATE conversations SET last_seq = last_seq + 1, message_count = message_count + 1, version = version + 1, updated_at = ? WHERE id = ? RETURNING last_seq').get<{ last_seq: number }>(now, conversationId)!.last_seq;
      tx.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, payload_json, client_message_id, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)").run(id, conversationId, seq, content, payload ? JSON.stringify(payload) : null, id, now);
      const changed = service.onUserMessage(tx, conversationId, id);
      if (changed.superseded) ids.push(appendTurnEvent(tx, turns, publisher, changed.superseded));
      ids.push(appendTurnEvent(tx, turns, publisher, changed.turn));
      return { ...changed, messageId: id };
    });
    publisher.flush(ids);
    return value;
  }
  let closed = false;
  return { directory, databasePath, database, domain, turns, events, publisher, service, runner, interpreters, errors, conversation, send,
    inject: (hook?: () => void) => { beforeCommit = hook; }, markClosed: () => { closed = true; },
    close: () => { if (!closed) { runner.dispose(); database.close(); closed = true; } rmSync(directory, { recursive: true, force: true }); },
  };
}
export async function socketHarness(h: ReturnType<typeof createHarness>, options: { serveWebDist?: boolean; heartbeatMs?: number } = {}) {
  const server = createServer((_req, res) => res.end('ok'));
  const realtime = new RealtimeServer(server, h.publisher, { webOrigins: ['http://test.invalid'], serveWebDist: options.serveWebDist ?? false,
    heartbeatMs: options.heartbeatMs, authenticateToken: token => token === 'valid' ? { userId: 'u', tokenHash: 'hash-valid' } : token === 'second' ? { userId: 'u', tokenHash: 'hash-second' } : token === 'other' ? { userId: 'other-user', tokenHash: 'hash-other' } : null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (typeof address !== 'object' || !address) throw new Error('Missing address');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const clients: WebSocket[] = [];
  async function connect(token = 'valid', origin = 'http://test.invalid') {
    const socket = new WebSocket(url, { headers: { Origin: origin, Cookie: `nc_token=${token}` } });
    const messages: ServerMessage[] = [];
    socket.on('message', data => { messages.push(JSON.parse(data.toString()) as ServerMessage); });
    clients.push(socket); await once(socket, 'open');
    return { socket, messages };
  }
  async function close() {
    for (const client of clients) client.terminate();
    await realtime.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return { server, realtime, url, connect, close };
}
