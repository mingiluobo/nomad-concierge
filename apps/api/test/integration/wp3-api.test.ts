import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProfile, conversationResponseSchema, conversationListResponseSchema, planResponseSchema } from '@nomad/shared';
import type { AssistantPayload, Profile, TurnDto } from '@nomad/shared';
import { AppDatabase } from '../../src/db/database.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Domain, EventPublisher, PendingEvent, TurnService } from '../../src/composition.js';
import { createDomain } from '../../src/domain/index.js';
import { loadKnowledge } from '../../src/knowledge/loader.js';
import { AuthenticationService } from '../../src/auth/service.js';
import { ConversationService } from '../../src/services/conversations.js';
import { createApiRouter } from '../../src/routes/api.js';
import { AppError, errorHandler } from '../../src/http/errors.js';

const disposals: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (disposals.length) disposals.pop()?.(); });
interface FakeTurnRow { id: string; conversation_id: string; status: TurnDto['status']; engine_requested: TurnDto['engineRequested']; created_at: string; version: number; retry_of_turn_id: string | null }
function fixture(environment: NodeJS.ProcessEnv = {}, wrapDomain: (domain: Domain) => Domain = domain => domain) {
  const directory = mkdtempSync(join(tmpdir(), 'nc-api-'));
  const control = { failCommit: false };
  const db = new AppDatabase(join(directory, 'test.sqlite'), { beforeCommit: () => { if (control.failCommit) { control.failCommit = false; throw new Error('commit rejected'); } } });
  const observer = new AppDatabase(join(directory, 'test.sqlite'));
  disposals.push(() => { observer.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const config = loadConfig({ ...environment, DATABASE_PATH: join(directory, 'test.sqlite'), LLM_API_KEY: '', LOCAL_LLM_MODEL: '' });
  const domain = wrapDomain(createDomain(loadKnowledge()));
  const closed: { hashes: string[]; code: number }[] = [];
  const registry = { closeByTokenHash: (hashes: string[], code: 4401) => closed.push({ hashes, code }) };
  const broadcasts: PendingEvent[] = [];
  const publisher: EventPublisher = {
    append(tx, event) { return Number(tx.prepare('INSERT INTO events (user_id, conversation_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(event.userId, event.conversationId, event.type, JSON.stringify(event.payload), new Date().toISOString()).lastInsertRowid); },
    flush(ids) {
      for (const id of ids) {
        const row = observer.prepare('SELECT user_id, conversation_id, type, payload_json FROM events WHERE id = ?').get<{ user_id: string; conversation_id: string | null; type: PendingEvent['type']; payload_json: string }>(id);
        expect(row, 'events must be visible to a second connection before broadcast').toBeDefined();
        broadcasts.push({ userId: row!.user_id, conversationId: row!.conversation_id ?? undefined, type: row!.type, payload: JSON.parse(row!.payload_json) } as PendingEvent);
      }
    },
  };
  const getTurn = (id: string): TurnDto | null => {
    const row = db.prepare('SELECT * FROM turns WHERE id = ?').get<FakeTurnRow>(id);
    return row ? { id: row.id, conversationId: row.conversation_id, status: row.status, stage: row.status === 'queued' ? 'queued' : 'done', engineRequested: row.engine_requested,
      engineUsed: null, fallbacks: [], errorCode: null, timings: {}, promptVersion: null, retryOfTurnId: row.retry_of_turn_id, attempt: 1,
      version: row.version, createdAt: row.created_at, startedAt: null, finishedAt: null } : null;
  };
  const latest = (id: string) => {
    const row = db.prepare('SELECT id FROM turns WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get<{ id: string }>(id);
    return row ? getTurn(row.id) : null;
  };
  const active = (id: string) => {
    const row = db.prepare("SELECT id FROM turns WHERE conversation_id = ? AND status IN ('queued', 'running')").get<{ id: string }>(id);
    return row ? getTurn(row.id) : null;
  };
  const newTurn = (tx: AppDatabase, id: string, retryOf?: string): TurnDto => {
    const turnId = randomUUID();
    const preference = tx.prepare('SELECT engine_preference FROM conversations WHERE id = ?').get<{ engine_preference: string }>(id)!.engine_preference;
    const input = tx.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' AND consumed_by_turn_id IS NULL ORDER BY seq").all<{ id: string }>(id).map(item => item.id);
    tx.prepare("INSERT INTO turns (id, conversation_id, status, stage, input_message_ids_json, engine_requested, retry_of_turn_id, created_at) VALUES (?, ?, 'queued', 'queued', ?, ?, ?, ?)").run(turnId, id, JSON.stringify(input), preference, retryOf, new Date().toISOString());
    return getTurn(turnId)!;
  };
  const turns: TurnService = {
    activeTurn: active,
    onUserMessage(tx, id) {
      const previous = active(id);
      if (previous) tx.prepare("UPDATE turns SET status = 'superseded', version = version + 1 WHERE id = ?").run(previous.id);
      return { turn: newTurn(tx, id), ...(previous ? { superseded: getTurn(previous.id)! } : {}) };
    },
    cancel(_id, turnId) {
      db.transaction(tx => tx.prepare("UPDATE turns SET status = 'cancelled', version = version + 1 WHERE id = ? AND status IN ('queued', 'running')").run(turnId));
      return getTurn(turnId)!;
    },
    retry(id, turnId) {
      const existing = active(id);
      if (existing) return { turn: existing, created: false };
      const target = getTurn(turnId);
      if (!target || target.id !== latest(id)?.id || !['cancelled', 'failed'].includes(target.status)) throw new AppError('TURN_NOT_RETRYABLE');
      return { turn: db.transaction(tx => newTurn(tx, id, turnId)), created: true };
    },
  };
  const auth = new AuthenticationService(db, registry, config);
  const service = new ConversationService(db, domain, turns, publisher, { get: id => { const turn = getTurn(id); return turn ? { turn } : undefined; }, latest }, config);
  const app = createApp({ database: db, webOrigins: config.webOrigins, router: createApiRouter({ auth, conversations: service, config,
    engines: { status: () => [{ id: 'rules', available: true }] } }), errorHandler });
  const login = async (username = 'Alice') => {
    const response = await request(app).post('/api/auth/login').send({ username });
    expect(response.status).toBe(200);
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    return { cookie, userId: response.body.user.id as string, response };
  };
  const create = async (cookie: string, clientMessageId = randomUUID(), content = '我想去葡萄牙') => {
    const response = await request(app).post('/api/conversations').set('Cookie', cookie).send({ content, clientMessageId });
    expect(response.status).toBe(201);
    return { id: response.body.conversation.id as string, turnId: response.body.turn.id as string, messageId: response.body.message.id as string, clientMessageId, response };
  };
  const complete = (id: string, profile: Profile = createEmptyProfile()) => {
    db.transaction(tx => {
      const turn = active(id)!;
      tx.prepare("UPDATE turns SET status = 'completed', stage = 'done', version = version + 1 WHERE id = ?").run(turn.id);
      const seq = tx.prepare('UPDATE conversations SET last_seq = last_seq + 1, message_count = message_count + 1, last_assistant_seq = last_seq + 1, profile_json = ?, version = version + 1 WHERE id = ? RETURNING last_seq').get<{ last_seq: number }>(JSON.stringify(profile), id)!.last_seq;
      const payload: AssistantPayload = { recorded: [], corrections: [], notices: [], questions: [], progress: domain.progress(profile), process: { engineUsed: 'rules', fallbacks: [], timings: {}, promptVersion: null } };
      tx.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, payload_json, turn_id, created_at) VALUES (?, ?, ?, 'assistant', '请继续补充', ?, ?, ?)").run(randomUUID(), id, seq, JSON.stringify(payload), turn.id, new Date().toISOString());
      tx.prepare("UPDATE messages SET consumed_by_turn_id = ? WHERE conversation_id = ? AND role = 'user' AND consumed_by_turn_id IS NULL").run(turn.id, id);
    });
  };
  return { db, observer, config, control, auth, service, app, closed, broadcasts, login, create, complete, active, latest, getTurn, directory };
}
function eligible(): Profile {
  const profile = createEmptyProfile();
  profile.slots.destination = { status: 'known', value: 'PT' };
  profile.slots.goals = { status: 'known', value: ['residence', 'tax'] };
  profile.slots.applicantNationality = { status: 'known', value: 'CN' };
  return profile;
}

describe('HTTP authentication and validation', () => {
  it('normalizes login identity, returns actual limits and stores only token hashes', async () => {
    const f = fixture({ LIMIT_MESSAGE_CHARS: '5000', LIMIT_MESSAGES_PER_CONVERSATION: '400' });
    const a = await f.login('  Alice  '); const b = await f.login('aLiCe');
    expect(a.userId).toBe(b.userId); expect(a.response.body.user.username).toBe('Alice');
    expect(a.response.body.limits).toEqual({ messageChars: 5000, messagesPerConversation: 400 });
    const me = await request(f.app).get('/api/me').set('Cookie', a.cookie);
    expect(me.body).toEqual({ user: { id: a.userId, username: 'Alice' }, limits: { messageChars: 5000, messagesPerConversation: 400 } });
    const raw = a.cookie.slice('nc_token='.length);
    const hashes = f.db.prepare('SELECT token_hash FROM auth_tokens').all<{ token_hash: string }>().map(row => row.token_hash);
    expect(hashes).not.toContain(raw); expect(hashes).toContain(createHash('sha256').update(raw).digest('hex'));
    expect((a.response.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Max-Age=315360000; Path=\/;.*HttpOnly; SameSite=Lax/);
  });
  it.each([
    { 'X-Forwarded-Proto': 'https' },
    { Forwarded: 'for=127.0.0.1;proto=https;host=localhost' },
    { 'X-Forwarded-Proto': 'https', Forwarded: 'for=127.0.0.1;proto=https;host=localhost' },
  ])('ignores proxy headers on production HTTP requests: %j', async headers => {
    const f = fixture({ NODE_ENV: 'production' });
    expect(f.app.get('trust proxy')).toBe(false);
    const response = await request(f.app).post('/api/auth/login').set(headers).send({ username: 'Alice' });
    expect(response.status).toBe(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    expect(cookies[0]).toMatch(/HttpOnly; SameSite=Lax/);
    expect(cookies[0]).not.toMatch(/(?:^|;\s*)Secure(?:;|$)/);
  });
  it('evicts the oldest token on the eleventh login and closes only affected connections', async () => {
    const f = fixture(); const first = await f.login(); let last = first;
    for (let i = 0; i < 10; i += 1) last = await f.login();
    expect((await request(f.app).get('/api/me').set('Cookie', first.cookie)).status).toBe(401);
    expect((await request(f.app).get('/api/me').set('Cookie', last.cookie)).status).toBe(200);
    expect(f.closed).toEqual([{ hashes: [createHash('sha256').update(first.cookie.slice(9)).digest('hex')], code: 4401 }]);
    const hash = createHash('sha256').update(last.cookie.slice(9)).digest('hex');
    const out = await request(f.app).post('/api/auth/logout').set('Cookie', last.cookie);
    expect(out.status).toBe(204); expect(f.closed.at(-1)).toEqual({ hashes: [hash], code: 4401 });
    expect((await request(f.app).get('/api/me').set('Cookie', last.cookie)).status).toBe(401);
  });
  it('requires authentication and returns structured validation, JSON and route errors', async () => {
    const f = fixture();
    expect((await request(f.app).get('/api/health')).status).toBe(200);
    for (const path of ['/api/me', '/api/engines', '/api/conversations', '/api/plans']) expect((await request(f.app).get(path)).status).toBe(401);
    const invalid = await request(f.app).post('/api/auth/login').send({ username: 'a' });
    expect(invalid.status).toBe(422); expect(invalid.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String), details: { issues: expect.any(Array) } });
    const badJson = await request(f.app).post('/api/auth/login').set('Content-Type', 'application/json').send('{');
    expect(badJson.status).toBe(400); expect(badJson.body.error.code).toBe('BAD_REQUEST');
    const huge = await request(f.app).post('/api/auth/login').send({ username: 'a'.repeat(70_000) });
    expect(huge.status).toBe(400);
    const { cookie } = await f.login("a'; DROP TABLE users;--");
    expect((await request(f.app).get('/api/missing').set('Cookie', cookie)).status).toBe(404);
    expect((await request(f.app).get('/api/engines').set('Cookie', cookie)).body).toEqual({ engines: [{ id: 'rules', available: true }] });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });
});

describe('conversation ownership, idempotency and persistence', () => {
  it('replays creation without duplicate conversation/message/turn even at the conversation limit', async () => {
    const f = fixture({ LIMIT_CONVERSATIONS_PER_USER: '1' }); const { cookie } = await f.login(); const c = await f.create(cookie);
    const events = f.broadcasts.length;
    const replay = await request(f.app).post('/api/conversations').set('Cookie', cookie).send({ clientMessageId: c.clientMessageId, content: 'different content' });
    expect(replay.status).toBe(200); expect(replay.body.conversation.id).toBe(c.id); expect(replay.body.message.id).toBe(c.messageId); expect(replay.body.turn.id).toBe(c.turnId);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM turns').get()).toEqual({ n: 1 }); expect(f.broadcasts).toHaveLength(events);
    const blocked = await request(f.app).post('/api/conversations').set('Cookie', cookie).send({ content: 'another', clientMessageId: randomUUID() });
    expect(blocked.status).toBe(422); expect(blocked.body.error.code).toBe('CONVERSATION_LIMIT_REACHED');
  });
  it('keeps concurrent creation idempotent and isolates the same client ID between users', async () => {
    const f = fixture(); const a = await f.login(); const b = await f.login('Bob'); const clientMessageId = randomUUID();
    const send = (cookie: string) => request(f.app).post('/api/conversations').set('Cookie', cookie).send({ content: '开始咨询', clientMessageId });
    const results = await Promise.all([send(a.cookie), send(a.cookie), send(b.cookie)]);
    expect(results.slice(0, 2).map(result => result.status).sort()).toEqual([200, 201]);
    expect(results[0]!.body.conversation.id).toBe(results[1]!.body.conversation.id);
    expect(results[2]!.status).toBe(201); expect(results[2]!.body.conversation.id).not.toBe(results[0]!.body.conversation.id);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 2 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 2 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM turns').get()).toEqual({ n: 2 });
  });
  it('replays concurrent new messages once and emits exactly one new/superseded turn event', async () => {
    const f = fixture(); const { cookie } = await f.login(); const c = await f.create(cookie); const id = randomUUID();
    const send = () => request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: '两个孩子', clientMessageId: id });
    const before = f.broadcasts.length; const responses = await Promise.all([send(), send()]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 202]); expect(responses[0]!.body.message.id).toBe(responses[1]!.body.message.id);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_message_id = ?').get(id)).toEqual({ n: 1 });
    expect(f.broadcasts.slice(before).map(event => event.type)).toEqual(['message.created', 'turn.upserted', 'turn.upserted', 'conversation.upserted']);
    expect(f.latest(c.id)?.status).toBe('queued'); expect(f.getTurn(c.turnId)?.status).toBe('superseded');
  });
  it('checks ownership before existing client IDs and before cancel/retry delegation', async () => {
    const f = fixture(); const a = await f.login(); const b = await f.login('Bob'); const c = await f.create(a.cookie); const other = await f.create(a.cookie);
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM messages').get(); const events = f.broadcasts.length;
    const denied = await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', b.cookie).send({ content: 'replay', clientMessageId: c.clientMessageId });
    expect(denied.status).toBe(404); expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual(count); expect(f.broadcasts).toHaveLength(events);
    for (const owner of [b.cookie, a.cookie]) {
      const urlId = owner === a.cookie ? other.id : c.id;
      for (const action of ['cancel', 'retry']) expect((await request(f.app).post(`/api/conversations/${urlId}/turns/${c.turnId}/${action}`).set('Cookie', owner)).status).toBe(404);
    }
    for (const suffix of ['', '/messages']) expect((await request(f.app).get(`/api/conversations/${c.id}${suffix}`).set('Cookie', b.cookie)).status).toBe(404);
    expect((await request(f.app).patch(`/api/conversations/${c.id}`).set('Cookie', b.cookie).send({ enginePreference: 'rules' })).status).toBe(404);
    expect((await request(f.app).post(`/api/conversations/${c.id}/read`).set('Cookie', b.cookie).send({ seq: 1 })).status).toBe(404);
    expect((await request(f.app).post(`/api/conversations/${c.id}/plan`).set('Cookie', b.cookie).send({ allowIncomplete: true })).status).toBe(404);
    expect(f.getTurn(c.turnId)?.status).toBe('queued');
  });
  it('returns list/summary/detail contracts, active tasks across filters, and persisted content after reopening', async () => {
    const f = fixture(); const { cookie } = await f.login(); const c = await f.create(cookie);
    const changed = await request(f.app).patch(`/api/conversations/${c.id}`).set('Cookie', cookie).send({ enginePreference: 'rules' });
    expect(changed.status).toBe(200); expect(changed.body.conversation.enginePreference).toBe('rules');
    const filtered = await request(f.app).get('/api/conversations?status=completed').set('Cookie', cookie);
    expect(conversationListResponseSchema.safeParse(filtered.body).success).toBe(true); expect(filtered.body.items).toEqual([]); expect(filtered.body.activeTurns[0].id).toBe(c.turnId);
    const detail = await request(f.app).get(`/api/conversations/${c.id}`).set('Cookie', cookie);
    expect(conversationResponseSchema.safeParse(detail.body).success).toBe(true); expect(detail.body.latestTurn.id).toBe(c.turnId);
    const reopened = new AppDatabase(f.config.databasePath);
    expect(reopened.prepare('SELECT engine_preference FROM conversations WHERE id = ?').get(c.id)).toEqual({ engine_preference: 'rules' }); reopened.close();
    expect((await request(f.app).get('/api/conversations?status=wrong').set('Cookie', cookie)).status).toBe(422);
  });
  it('pages 75 messages without gaps or duplicates while a new message is appended', async () => {
    const f = fixture(); const { cookie } = await f.login(); const c = await f.create(cookie);
    f.db.transaction(tx => {
      for (let seq = 2; seq <= 75; seq += 1) tx.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)").run(randomUUID(), c.id, seq, `message ${seq}`, new Date().toISOString());
      tx.prepare('UPDATE conversations SET last_seq = 75, message_count = 75 WHERE id = ?').run(c.id);
    });
    const one = await request(f.app).get(`/api/conversations/${c.id}/messages`).set('Cookie', cookie);
    expect(one.body.items.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => 46 + i)); expect(one.body.nextCursor).toBe(46);
    expect((await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: 'newer', clientMessageId: randomUUID() })).status).toBe(202);
    const two = await request(f.app).get(`/api/conversations/${c.id}/messages?before=46`).set('Cookie', cookie);
    const three = await request(f.app).get(`/api/conversations/${c.id}/messages?before=${two.body.nextCursor}`).set('Cookie', cookie);
    expect(two.body.nextCursor).toBe(16); expect(three.body.nextCursor).toBeNull();
    expect([...three.body.items, ...two.body.items, ...one.body.items].map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 75 }, (_, i) => i + 1));
    expect((await request(f.app).get(`/api/conversations/${c.id}/messages?limit=101`).set('Cookie', cookie)).status).toBe(422);
  });
  it('marks reads monotonically, clamps future sequence numbers and broadcasts only real increases', async () => {
    const f = fixture(); const { cookie } = await f.login(); const c = await f.create(cookie); f.complete(c.id);
    const before = f.broadcasts.length;
    const future = await request(f.app).post(`/api/conversations/${c.id}/read`).set('Cookie', cookie).send({ seq: 99 });
    expect(future.status).toBe(200);
    expect(future.body).toEqual({ lastReadSeq: 2 });
    const lower = await request(f.app).post(`/api/conversations/${c.id}/read`).set('Cookie', cookie).send({ seq: 1 });
    expect(lower.body).toEqual({ lastReadSeq: 2 }); expect(f.broadcasts.slice(before)).toHaveLength(1);
    expect(f.broadcasts.at(-1)?.type).toBe('read_state.updated');
    expect((await request(f.app).post(`/api/conversations/${c.id}/read`).set('Cookie', cookie).send({ seq: -1 })).status).toBe(422);
  });
});

describe('server limits, plan transactions and recoverability', () => {
  it('rejects blank text and invalid answers but accepts a valid answer without text', async () => {
    const f = fixture({ LIMIT_MESSAGE_CHARS: '4' }); const { cookie } = await f.login(); const c = await f.create(cookie, randomUUID(), 'start'.slice(0, 4));
    const send = (content: string, payload?: unknown) => request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content, payload, clientMessageId: randomUUID() });
    for (const payload of [undefined, { answers: [] }, { answers: [{ slot: 'childrenCount', value: -1, label: '无效' }] }, { answers: [{ slot: 'destination', label: '缺值' }] }]) {
      const rejected = await send('  ', payload);
      expect(rejected.status).toBe(422); expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    }
    const answer = { answers: [{ slot: 'applicantNationality', value: 'CN', label: '中国' }] };
    const accepted = await send('', answer); expect(accepted.status).toBe(202); expect(accepted.body.message.payload).toEqual(answer);
    const display = await send('这个选项文字超过了四个字', answer); expect(display.status).toBe(202);
    expect(f.db.prepare('SELECT message_count FROM conversations WHERE id = ?').get(c.id)).toEqual({ message_count: 3 });
  });
  it('enforces lower and higher configured message lengths rather than hard-coded defaults', async () => {
    for (const limit of [4, 2200]) {
      const f = fixture({ LIMIT_MESSAGE_CHARS: String(limit) }); const { cookie, response } = await f.login();
      expect(response.body.limits.messageChars).toBe(limit);
      const c = await f.create(cookie, randomUUID(), 'a'.repeat(limit));
      const rejected = await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: 'a'.repeat(limit + 1), clientMessageId: randomUUID() });
      expect(rejected.status).toBe(422); expect(rejected.body.error).toMatchObject({ code: 'MESSAGE_TOO_LONG', details: { limit } });
      expect(f.db.prepare('SELECT message_count FROM conversations WHERE id = ?').get(c.id)).toEqual({ message_count: 1 });
    }
  });
  it('reserves one reply at N-2, rejects at N-1/N, and replays old messages after full', async () => {
    const f = fixture({ LIMIT_MESSAGES_PER_CONVERSATION: '4' }); const { cookie } = await f.login(); const c = await f.create(cookie);
    for (let i = 0; i < 2; i += 1) expect((await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: `input ${i}`, clientMessageId: randomUUID() })).status).toBe(202);
    const send = () => request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: 'overflow', clientMessageId: randomUUID() });
    expect((await send()).body.error.code).toBe('CONVERSATION_FULL'); f.complete(c.id, eligible());
    expect(f.db.prepare('SELECT message_count FROM conversations WHERE id = ?').get(c.id)).toEqual({ message_count: 4 });
    expect((await send()).body.error.code).toBe('CONVERSATION_FULL');
    const replay = await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: 'different', clientMessageId: c.clientMessageId });
    expect(replay.status).toBe(200); expect(replay.body.message.id).toBe(c.messageId); expect(replay.body.turn).toBeNull();
  });
  it('keeps the final reply reserved through cancellation and repeated retry requests at the minimum cap', async () => {
    const f = fixture({ LIMIT_MESSAGES_PER_CONVERSATION: '2' }); const { cookie } = await f.login(); const c = await f.create(cookie);
    const cancel = () => request(f.app).post(`/api/conversations/${c.id}/turns/${c.turnId}/cancel`).set('Cookie', cookie);
    expect((await cancel()).body.turn.status).toBe('cancelled'); expect((await cancel()).status).toBe(200);
    const retry = () => request(f.app).post(`/api/conversations/${c.id}/turns/${c.turnId}/retry`).set('Cookie', cookie);
    const first = await retry(); const repeated = await retry(); expect(first.status).toBe(202); expect(repeated.status).toBe(200); expect(repeated.body.turn.id).toBe(first.body.turn.id);
    expect((await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: 'extra', clientMessageId: randomUUID() })).body.error.code).toBe('CONVERSATION_FULL');
    f.complete(c.id, eligible()); expect(f.db.prepare('SELECT message_count FROM conversations WHERE id = ?').get(c.id)).toEqual({ message_count: 2 });
    expect((await retry()).body.error.code).toBe('TURN_NOT_RETRYABLE');
  });
  it('rejects active/unprocessed/insufficient/incomplete plans, then persists a complete plan response idempotently', async () => {
    const f = fixture(); const a = await f.login(); const b = await f.login('Bob'); const c = await f.create(a.cookie);
    const generate = (body = {}) => request(f.app).post(`/api/conversations/${c.id}/plan`).set('Cookie', a.cookie).send(body);
    expect((await generate()).body.error.code).toBe('TURN_IN_PROGRESS');
    expect((await request(f.app).post(`/api/conversations/${c.id}/turns/${c.turnId}/cancel`).set('Cookie', a.cookie)).status).toBe(200);
    const pending = await generate(); expect(pending.status).toBe(409); expect(pending.body.error).toMatchObject({ code: 'UNPROCESSED_MESSAGES', details: { count: 1 } });
    const retry = await request(f.app).post(`/api/conversations/${c.id}/turns/${c.turnId}/retry`).set('Cookie', a.cookie);
    expect(retry.status).toBe(202); expect(retry.body.turn.retryOfTurnId).toBe(c.turnId);
    f.complete(c.id);
    expect((await generate()).body.error.code).toBe('PROFILE_INSUFFICIENT');
    const correction = await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', a.cookie).send({ content: '中国籍，居留和税务', clientMessageId: randomUUID() });
    expect(correction.status).toBe(202); f.complete(c.id, eligible());
    expect((await generate()).body.error.code).toBe('PROFILE_INCOMPLETE');
    const created = await generate({ allowIncomplete: true });
    expect(created.status).toBe(201); expect(planResponseSchema.safeParse(created.body).success).toBe(true);
    expect(created.body.plan.content.profileSummary.known).toEqual(expect.arrayContaining([{ slot: 'destination', label: '目的国', display: '葡萄牙' }, { slot: 'applicantNationality', label: '本人国籍', display: '中国' }]));
    expect(created.body.plan.content.generatedEarly).toBe(true);
    const replay = await generate(); expect(replay.status).toBe(200); expect(replay.body).toEqual(created.body);
    const completed = await request(f.app).get(`/api/conversations/${c.id}`).set('Cookie', a.cookie);
    expect(completed.body.conversation.status).toBe('completed'); expect(completed.body.plan.id).toBe(created.body.plan.id);
    expect((await request(f.app).get('/api/plans').set('Cookie', a.cookie)).body.items).toHaveLength(1);
    expect((await request(f.app).get(`/api/plans/${created.body.plan.id}`).set('Cookie', a.cookie)).body).toEqual(created.body);
    expect((await request(f.app).get(`/api/plans/${created.body.plan.id}`).set('Cookie', b.cookie)).status).toBe(404);
    expect((await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', a.cookie).send({ content: 'new', clientMessageId: randomUUID() })).body.error.code).toBe('CONVERSATION_COMPLETED');
    expect((await request(f.app).patch(`/api/conversations/${c.id}`).set('Cookie', a.cookie).send({ enginePreference: 'rules' })).body.error.code).toBe('CONVERSATION_COMPLETED');
    const old = await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', a.cookie).send({ content: 'replay', clientMessageId: c.clientMessageId });
    expect(old.status).toBe(200); expect(old.body.message.id).toBe(c.messageId);
  });
  it('rechecks unprocessed messages inside the plan transaction after preparation', async () => {
    const f = fixture({}, domain => ({ ...domain, generatePlan: (...args) => { const result = domain.generatePlan(...args); mutate?.(); return result; } }));
    const { cookie } = await f.login(); const c = await f.create(cookie); f.complete(c.id, eligible());
    const mutate = () => {
      f.db.transaction(tx => {
        tx.prepare("INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, 3, 'user', 'new correction', ?)").run(randomUUID(), c.id, new Date().toISOString());
        tx.prepare('UPDATE conversations SET last_seq = 3, message_count = 3, version = version + 1 WHERE id = ?').run(c.id);
      });
    };
    const response = await request(f.app).post(`/api/conversations/${c.id}/plan`).set('Cookie', cookie).send({ allowIncomplete: true });
    expect(response.status).toBe(409); expect(response.body.error.code).toBe('UNPROCESSED_MESSAGES');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 0 }); expect(f.db.prepare('SELECT status FROM conversations WHERE id = ?').get(c.id)).toEqual({ status: 'collecting' });
  });
  it.each(['TURN_TIMEOUT', 'INTERNAL_ERROR'])('does not finalize stale profile information after %s', async errorCode => {
    const f = fixture(); const { cookie } = await f.login(); const c = await f.create(cookie); f.complete(c.id, eligible());
    const correction = await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: '改去西班牙', clientMessageId: randomUUID() });
    f.db.prepare("UPDATE turns SET status = 'failed', error_code = ? WHERE id = ?").run(errorCode, correction.body.turn.id);
    const blocked = await request(f.app).post(`/api/conversations/${c.id}/plan`).set('Cookie', cookie).send({ allowIncomplete: true });
    expect(blocked.status).toBe(409); expect(blocked.body.error).toMatchObject({ code: 'UNPROCESSED_MESSAGES', details: { count: 1 } });
    expect((await request(f.app).post(`/api/conversations/${c.id}/turns/${correction.body.turn.id}/retry`).set('Cookie', cookie)).status).toBe(202);
    const corrected = eligible(); corrected.slots.destination = { status: 'known', value: 'ES' }; f.complete(c.id, corrected);
    const plan = await request(f.app).post(`/api/conversations/${c.id}/plan`).set('Cookie', cookie).send({ allowIncomplete: true });
    expect(plan.status).toBe(201); expect(plan.body.plan.destination).toBe('ES'); expect(plan.body.plan.coverage).toBe('generic');
  });
  it('generates from a fully answered profile without early-generation confirmation and survives reopening', async () => {
    const f = fixture(); const { cookie } = await f.login(); const c = await f.create(cookie);
    const profile = eligible();
    profile.slots.hasPartner = { status: 'known', value: false }; profile.slots.childrenCount = { status: 'known', value: 0 };
    profile.slots.currentResidence = { status: 'known', value: 'CN' }; profile.slots.residenceStatus = { status: 'known', value: 'citizen' };
    profile.slots.timeline = { status: 'known', value: '6to12m' }; profile.slots.incomeSource = { status: 'known', value: 'freelancer' };
    profile.slots.incomeCountry = { status: 'known', value: 'CN' }; f.complete(c.id, profile);
    const response = await request(f.app).post(`/api/conversations/${c.id}/plan`).set('Cookie', cookie).send({});
    expect(response.status).toBe(201); expect(response.body.plan.content.generatedEarly).toBe(false); expect(response.body.plan.toConfirmCount).toBe(0);
    const reopened = new AppDatabase(f.config.databasePath);
    const stored = reopened.prepare('SELECT content_json FROM plans WHERE id = ?').get<{ content_json: string }>(response.body.plan.id);
    expect(JSON.parse(stored!.content_json)).toEqual(response.body.plan.content); reopened.close();
    const originalCreation = await request(f.app).post('/api/conversations').set('Cookie', cookie).send({ content: 'replay', clientMessageId: c.clientMessageId });
    expect(originalCreation.status).toBe(200); expect(originalCreation.body.conversation.status).toBe('completed'); expect(originalCreation.body.turn.status).toBe('completed');
  });
  it('allows only one winner when generation and a new message arrive together', async () => {
    const f = fixture(); const { cookie } = await f.login(); const c = await f.create(cookie); f.complete(c.id, eligible());
    const [plan, message] = await Promise.all([
      request(f.app).post(`/api/conversations/${c.id}/plan`).set('Cookie', cookie).send({ allowIncomplete: true }),
      request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: 'new', clientMessageId: randomUUID() }),
    ]);
    expect((plan.status === 201 && message.status === 409) || (plan.status === 409 && message.status === 202)).toBe(true);
    const plans = f.db.prepare('SELECT COUNT(*) AS n FROM plans').get<{ n: number }>()!.n;
    expect(plans).toBe(plan.status === 201 ? 1 : 0);
  });
  it('rolls back creation/message/plan writes and broadcasts nothing when commit fails', async () => {
    const f = fixture(); const { cookie } = await f.login(); vi.spyOn(console, 'error').mockImplementation(() => undefined);
    f.control.failCommit = true;
    const failedCreate = await request(f.app).post('/api/conversations').set('Cookie', cookie).send({ content: 'start', clientMessageId: randomUUID() });
    expect(failedCreate.status).toBe(500); expect(failedCreate.body.error.code).toBe('INTERNAL_ERROR'); expect(JSON.stringify(failedCreate.body)).not.toContain('commit rejected');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 0 }); expect(f.broadcasts).toEqual([]);
    const c = await f.create(cookie); const events = f.broadcasts.length; f.control.failCommit = true;
    const failedMessage = await request(f.app).post(`/api/conversations/${c.id}/messages`).set('Cookie', cookie).send({ content: 'append', clientMessageId: randomUUID() });
    expect(failedMessage.status).toBe(500); expect(f.broadcasts).toHaveLength(events); expect(f.db.prepare('SELECT message_count FROM conversations WHERE id = ?').get(c.id)).toEqual({ message_count: 1 }); expect(f.getTurn(c.turnId)?.status).toBe('queued');
    f.complete(c.id, eligible()); f.control.failCommit = true;
    const failedPlan = await request(f.app).post(`/api/conversations/${c.id}/plan`).set('Cookie', cookie).send({ allowIncomplete: true });
    expect(failedPlan.status).toBe(500); expect(f.broadcasts).toHaveLength(events);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 0 }); expect(f.db.prepare('SELECT status FROM conversations WHERE id = ?').get(c.id)).toEqual({ status: 'collecting' });
  });
});
