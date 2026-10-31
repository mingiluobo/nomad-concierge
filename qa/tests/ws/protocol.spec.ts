import { request as playwrightRequest } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { test as base, expect } from '../../fixtures/test.js';
import { SocketProbe, cookieHeader, handshakeStatus, type SocketOptions } from '../../harness/socket.js';
import { cases } from '../../catalog/ws.js';
import type { BusinessEvent, ServerMessage } from '../../../packages/shared/src/events.js';
import { planSummaryDtoSchema } from '../../../packages/shared/src/dto.js';

const title = (id: string) => `${id} ${cases.find(item => item.id === id)!.title}`;
const isEvent = (message: ServerMessage): message is BusinessEvent => message.type === 'event';
const events = (probe: SocketProbe) => probe.messages.filter(isEvent);
const messageEvents = (probe: SocketProbe, conversationId: string) => events(probe).filter(event => event.eventType === 'message.created' && event.payload.message.conversationId === conversationId);

const test = base.extend<{ openSocket: (options?: SocketOptions) => Promise<SocketProbe> }>({
  openSocket: async ({ app, api }, provide, testInfo) => {
    const probes: SocketProbe[] = [];
    await provide(async options => {
      const probe = await SocketProbe.connect(app.baseURL, { cookie: await cookieHeader(api.request), ...options });
      probes.push(probe);
      return probe;
    });
    for (const [index, probe] of probes.entries()) {
      await testInfo.attach(`socket-${index + 1}.json`, { body: JSON.stringify({ messages: probe.messages, invalidMessages: probe.invalidMessages, errors: probe.errors, pingTimes: probe.pingTimes, closed: probe.closed }, null, 2), contentType: 'application/json' });
      await probe.close();
      expect(probe.invalidMessages, '每条服务端消息必须满足共享协议 schema').toEqual([]);
    }
  },
});

async function loggedInContext(baseURL: string, username: string): Promise<APIRequestContext> {
  const request = await playwrightRequest.newContext({ baseURL });
  const response = await request.post('/api/auth/login', { data: { username } });
  expect(response.status()).toBe(200);
  return request;
}

async function ready(probe: SocketProbe, cursor: number | null = null) {
  probe.resume(cursor);
  return probe.waitReady();
}

test(title('WS-001'), async ({ app }) => {
  expect(await handshakeStatus(app.baseURL, {})).toBe(401);
});

test(title('WS-002'), async ({ app }) => {
  expect(await handshakeStatus(app.baseURL, { cookie: 'nc_token=invalid-token' })).toBe(401);
});

test(title('WS-003'), async ({ app, api }) => {
  await api.login();
  const cookie = await cookieHeader(api.request);
  expect(await handshakeStatus(app.baseURL, { cookie, origin: 'https://untrusted.invalid' })).toBe(403);
  expect(await handshakeStatus(app.baseURL, { cookie, origin: null })).toBe(403);
});

test(title('WS-004'), async ({ api, openSocket }) => {
  await api.login();
  const created = await api.create('我想去葡萄牙生活，我是中国籍。');
  await api.settle(created.conversation.id);
  const generated = await api.plan(created.conversation.id, true);
  const before = await api.detail(created.conversation.id);
  const messages = await api.messages(created.conversation.id);
  const user = await (await api.request.get('/api/me')).json();
  const socket = await openSocket();
  const handshake = await ready(socket);
  expect(handshake.userId).toBe(user.user.id);
  expect(handshake.latestEventId).toBeGreaterThan(0);
  expect(socket.messages.filter(isEvent)).toEqual([]);
  expect(await api.detail(created.conversation.id)).toEqual(before);
  expect(await api.messages(created.conversation.id)).toEqual(messages);
  const persisted = await (await api.request.get(`/api/plans/${generated.plan.id}`)).json();
  expect(persisted.plan).toEqual(generated.plan);
  expect(before.conversation.status).toBe('completed');
  expect(before.plan?.id).toBe(generated.plan.id);
});

test(title('WS-005'), async ({ api, openSocket }) => {
  await api.login();
  const socket = await openSocket();
  await ready(socket);
  const created = await api.create('我想搬到葡萄牙生活。');
  await api.settle(created.conversation.id);
  await socket.waitFor(message => isEvent(message) && message.eventType === 'turn.upserted' && message.payload.turn.id === created.turn.id && message.payload.turn.status === 'completed');
  const stored = await api.messages(created.conversation.id);
  const actual = messageEvents(socket, created.conversation.id);
  expect(actual.map(event => event.eventType === 'message.created' ? event.payload.message : null)).toEqual(stored.items);
  expect(actual).toHaveLength(2);
  const detail = await api.detail(created.conversation.id);
  const snapshots = events(socket).filter(event => event.eventType === 'conversation.upserted' && event.payload.conversation.id === created.conversation.id);
  expect(snapshots.length).toBeGreaterThanOrEqual(2);
  const last = snapshots.at(-1)!;
  expect(last.eventType === 'conversation.upserted' && last.payload.conversation).toEqual(detail.conversation);
  const turns = events(socket).filter(event => event.eventType === 'turn.upserted').map(event => event.eventType === 'turn.upserted' ? event.payload.turn : undefined).filter(turn => turn?.id === created.turn.id);
  expect(turns.map(turn => turn!.stage)).toEqual(expect.arrayContaining(['queued', 'understanding', 'deciding', 'replying', 'done']));
  expect(turns.map(turn => turn!.version)).toEqual([...new Set(turns.map(turn => turn!.version))].sort((a, b) => a - b));
  for (let index = 1; index < turns.length; index += 1) expect(turns[index]!.version).toBe(turns[index - 1]!.version + 1);
  const ids = events(socket).map(event => event.id);
  expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
});

test(title('WS-006'), async ({ api, openSocket }) => {
  await api.login();
  const witness = await openSocket();
  const cursor = (await ready(witness)).latestEventId;
  const disconnected = await openSocket();
  await ready(disconnected, cursor);
  await disconnected.close();
  const created = await api.create('我想搬到葡萄牙生活。');
  await api.settle(created.conversation.id);
  await witness.waitFor(message => isEvent(message) && message.eventType === 'turn.upserted' && message.payload.turn.id === created.turn.id && message.payload.turn.status === 'completed');
  const reconnected = await openSocket();
  const resumeReady = await ready(reconnected, cursor);
  const expected = events(witness).filter(event => event.id > cursor && event.id <= resumeReady.latestEventId);
  expect(events(reconnected)).toEqual(expected);
  expect(expected.length).toBeGreaterThan(0);
  expect(reconnected.messages.at(-1)?.type).toBe('ready');
  const sent = await api.send(created.conversation.id, '我是中国籍。');
  await reconnected.waitFor(message => isEvent(message) && message.eventType === 'message.created' && message.payload.message.id === sent.message.id);
});

for (const count of [1000, 1001]) {
  test(title(count === 1000 ? 'WS-007' : 'WS-008'), async ({ api, openSocket }) => {
    test.setTimeout(180_000);
    await api.login();
    const created = await api.create('我想去葡萄牙生活，我是中国籍。');
    await api.settle(created.conversation.id);
    const planConversation = await api.create('我想去葡萄牙生活，我是中国籍。');
    await api.settle(planConversation.conversation.id);
    const plan = await api.plan(planConversation.conversation.id, true);
    const witness = await openSocket();
    const cursor = (await ready(witness)).latestEventId;
    for (let index = 0; index < count; index += 1) {
      const response = await api.request.patch(`/api/conversations/${created.conversation.id}`, { data: { enginePreference: index % 2 === 0 ? 'remote' : 'rules' } });
      expect(response.status()).toBe(200);
    }
    await expect.poll(() => events(witness).length).toBe(count);
    const reconnected = await openSocket();
    const resumed = await ready(reconnected, cursor);
    if (count === 1000) {
      expect(events(reconnected)).toEqual(events(witness));
      expect(reconnected.messages.some(message => message.type === 'resync_required')).toBe(false);
    } else {
      expect(reconnected.messages.map(message => message.type)).toEqual(['resync_required', 'ready']);
      expect(resumed.latestEventId).toBeGreaterThan(cursor);
      const list = await (await api.request.get('/api/conversations')).json();
      expect(list.items.map((item: { id: string }) => item.id).sort()).toEqual([created.conversation.id, planConversation.conversation.id].sort());
      const detail = await api.detail(created.conversation.id);
      expect(detail.conversation.enginePreference).toBe('remote');
      const restoredPlan = await (await api.request.get(`/api/plans/${plan.plan.id}`)).json();
      expect(restoredPlan.plan).toEqual(plan.plan);
    }
  });
}

test(title('WS-009'), async ({ app, api, openSocket }) => {
  await api.login('qa-user-a');
  const ownerSocket = await openSocket();
  await ready(ownerSocket);
  const own = await api.create('我想去葡萄牙。');
  await api.settle(own.conversation.id);
  const foreign = await loggedInContext(app.baseURL, 'qa-user-b');
  try {
    const response = await foreign.post('/api/conversations', { data: { content: '我想去法国生活。', clientMessageId: api.id() } });
    expect(response.status()).toBe(201);
    const other = await response.json();
    await expect.poll(async () => (await (await foreign.get(`/api/conversations/${other.conversation.id}`)).json()).latestTurn.status).toBe('completed');
    await ownerSocket.expectNoEvents(message => isEvent(message) && message.conversationId === other.conversation.id);
    expect(events(ownerSocket).some(event => event.conversationId === other.conversation.id)).toBe(false);
    const replay = await openSocket();
    await ready(replay, 0);
    expect(events(replay).length).toBeGreaterThan(0);
    expect(events(replay).every(event => !event.conversationId || event.conversationId === own.conversation.id)).toBe(true);
  } finally { await foreign.dispose(); }
});

test(title('WS-010'), async ({ app, api, openSocket }) => {
  await api.login('qa-logout-user');
  const oldCookie = await cookieHeader(api.request);
  const first = await openSocket();
  const second = await openSocket();
  await Promise.all([ready(first), ready(second)]);
  const other = await loggedInContext(app.baseURL, 'qa-logout-user');
  try {
    const retained = await openSocket({ cookie: await cookieHeader(other) });
    await ready(retained);
    expect((await api.request.post('/api/auth/logout')).status()).toBe(204);
    expect((await first.waitClose()).code).toBe(4401);
    expect((await second.waitClose()).code).toBe(4401);
    expect(await handshakeStatus(app.baseURL, { cookie: oldCookie })).toBe(401);
    const counts = [first.messages.length, second.messages.length];
    const result = await other.post('/api/conversations', { data: { content: '我想去葡萄牙。', clientMessageId: api.id() } });
    expect(result.status()).toBe(201);
    const created = await result.json();
    await retained.waitFor(message => isEvent(message) && message.eventType === 'message.created' && message.payload.message.id === created.message.id);
    expect([first.messages.length, second.messages.length]).toEqual(counts);
  } finally { await other.dispose(); }
});

test.describe('令牌淘汰隔离实例', () => {
  test.use({ appEnv: { TOKENS_PER_USER: '2' } });
  test(title('WS-011'), async ({ app, api, openSocket }) => {
    await api.login('qa-token-limit');
    const firstCookie = await cookieHeader(api.request);
    const first = await openSocket();
    await ready(first);
    const secondContext = await loggedInContext(app.baseURL, 'qa-token-limit');
    let thirdContext: APIRequestContext | undefined;
    try {
      const second = await openSocket({ cookie: await cookieHeader(secondContext) });
      await ready(second);
      thirdContext = await loggedInContext(app.baseURL, 'qa-token-limit');
      expect((await first.waitClose()).code).toBe(4401);
      expect(await handshakeStatus(app.baseURL, { cookie: firstCookie })).toBe(401);
      const third = await openSocket({ cookie: await cookieHeader(thirdContext) });
      await ready(third);
      const response = await thirdContext.post('/api/conversations', { data: { content: '我想去葡萄牙。', clientMessageId: api.id() } });
      expect(response.status()).toBe(201);
      const created = await response.json();
      for (const socket of [second, third]) {
        await socket.waitFor(message => isEvent(message) && message.eventType === 'message.created' && message.payload.message.id === created.message.id);
        expect(socket.closed).toBeUndefined();
      }
    } finally { await secondContext.dispose(); await thirdContext?.dispose(); }
  });
});

test(title('WS-012'), async ({ api, openSocket }) => {
  await api.login();
  const socket = await openSocket();
  await ready(socket);
  const created = await api.create('我想去葡萄牙生活，我是中国籍。');
  const settled = await api.settle(created.conversation.id);
  const plan = await api.plan(created.conversation.id, true);
  const event = await socket.waitFor(message => isEvent(message) && message.eventType === 'plan.created' && message.payload.plan.id === plan.plan.id);
  expect(event.type === 'event' && event.eventType === 'plan.created' && event.payload.plan).toEqual(planSummaryDtoSchema.parse(plan.plan));
  await socket.waitFor(message => isEvent(message) && message.eventType === 'conversation.upserted' && message.payload.conversation.id === created.conversation.id && message.payload.conversation.status === 'completed' && message.payload.conversation.planId === plan.plan.id);
  const read = await api.request.post(`/api/conversations/${created.conversation.id}/read`, { data: { seq: settled.conversation.lastSeq } });
  expect(read.status()).toBe(200);
  const marked = await read.json();
  const readEvent = await socket.waitFor(message => isEvent(message) && message.eventType === 'read_state.updated' && message.payload.conversationId === created.conversation.id && message.payload.lastReadSeq === marked.lastReadSeq);
  expect(readEvent.type).toBe('event');
  expect((await api.detail(created.conversation.id)).readState.lastReadSeq).toBe(marked.lastReadSeq);
});

test(title('WS-013'), async ({ api, openSocket }) => {
  await api.login();
  const socket = await openSocket();
  await ready(socket);
  const created = await api.create('我想去葡萄牙生活。');
  await api.settle(created.conversation.id);
  const sent = await Promise.all([api.send(created.conversation.id, '我是中国籍。'), api.send(created.conversation.id, '没有孩子。')]);
  await api.settle(created.conversation.id);
  for (const result of sent) await socket.waitFor(message => isEvent(message) && message.eventType === 'message.created' && message.payload.message.id === result.message.id);
  const stored = await api.messages(created.conversation.id);
  for (const result of sent) expect(stored.items.filter(message => message.id === result.message.id)).toHaveLength(1);
  const seqs = stored.items.map(message => message.seq);
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
  await expect.poll(() => messageEvents(socket, created.conversation.id).length).toBe(stored.items.length);
  const actual = messageEvents(socket, created.conversation.id).map(event => event.eventType === 'message.created' ? event.payload.message : null);
  expect(actual.filter(message => message?.role === 'user')).toEqual(stored.items.filter(message => message.role === 'user'));
});

test(title('WS-014'), async ({ api, openSocket }) => {
  await api.login();
  const socket = await openSocket();
  await ready(socket, Number.MAX_SAFE_INTEGER);
  expect(events(socket)).toEqual([]);
  const created = await api.create('我想去葡萄牙。');
  await socket.waitFor(message => isEvent(message) && message.eventType === 'message.created' && message.payload.message.id === created.message.id);
});

test(title('WS-015'), async ({ api, openSocket }) => {
  await api.login();
  const created = await api.create('我想去葡萄牙。');
  await api.settle(created.conversation.id);
  const before = await api.detail(created.conversation.id);
  const socket = await openSocket();
  await ready(socket);
  const payload = JSON.stringify({ type: 'resume', lastEventId: null, extra: 'x'.repeat(4096) });
  expect(Buffer.byteLength(payload)).toBeGreaterThan(4096);
  socket.socket.send(payload);
  await socket.waitClose();
  expect(await api.detail(created.conversation.id)).toEqual(before);
});

test(title('WS-016'), async ({ api, openSocket }) => {
  test.setTimeout(70_000);
  await api.login();
  const socket = await openSocket();
  await ready(socket);
  await socket.waitForPing(2, 60_000);
  const interval = socket.pingTimes[1]! - socket.pingTimes[0]!;
  expect(interval).toBeGreaterThanOrEqual(23_000);
  expect(interval).toBeLessThanOrEqual(30_000);
  const created = await api.create('我想去葡萄牙。');
  await socket.waitFor(message => isEvent(message) && message.eventType === 'message.created' && message.payload.message.id === created.message.id);
  expect(socket.closed).toBeUndefined();
});

test(title('WS-017'), async ({ api, openSocket }) => {
  test.setTimeout(100_000);
  await api.login();
  const socket = await openSocket({ autoPong: false });
  await ready(socket);
  await socket.waitClose(90_000);
  expect(socket.pingTimes.length).toBeGreaterThanOrEqual(2);
});

test.describe('Origin 白名单隔离实例', () => {
  test.use({ appEnv: { WEB_ORIGIN: 'https://allowed-one.invalid,https://allowed-two.invalid' } });
  test(title('WS-018'), async ({ app, api, openSocket }) => {
    await api.login();
    const me = await (await api.request.get('/api/me')).json();
    for (const origin of ['https://allowed-one.invalid', 'https://allowed-two.invalid', app.baseURL]) {
      const socket = await openSocket({ origin });
      expect((await ready(socket)).userId).toBe(me.user.id);
    }
  });
});

test(title('WS-019'), async ({ api, openSocket }) => {
  await api.login();
  const created = await api.create('我想去葡萄牙。');
  await api.settle(created.conversation.id);
  const before = await api.detail(created.conversation.id);
  const socket = await openSocket();
  socket.socket.send('{broken json');
  await ready(socket);
  expect(socket.closed).toBeUndefined();
  expect(await api.detail(created.conversation.id)).toEqual(before);
});
