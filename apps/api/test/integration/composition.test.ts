import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationResponseSchema, messagesResponseSchema, planResponseSchema, serverMessageSchema } from '@nomad/shared';
import type { ServerMessage } from '@nomad/shared';
import { createComposition } from '../../src/composition.js';
import { loadConfig } from '../../src/config.js';
import { AppDatabase } from '../../src/db/database.js';
import * as knowledgeLoader from '../../src/knowledge/loader.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
  vi.restoreAllMocks();
});
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'nc-composition-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function fixture(environment: NodeJS.ProcessEnv = {}, databasePath = join(temporaryDirectory(), 'app.sqlite')) {
  const config = loadConfig({ PORT: '0', LLM_API_KEY: '', LOCAL_LLM_MODEL: '', ...environment, DATABASE_PATH: databasePath });
  const application = createComposition(config);
  cleanup.push(application.shutdown);
  await application.start();
  const address = application.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const origin = `http://localhost:${address.port}`;
  const agent = request.agent(application.server);
  const login = await agent.post('/api/auth/login').send({ username: 'Integrated user' }).expect(200);
  const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return { ...application, agent, origin, cookie, databasePath, config };
}
async function completed(agent: ReturnType<typeof request.agent>, id: string) {
  let body: ReturnType<typeof conversationResponseSchema.parse> | undefined;
  await vi.waitFor(async () => {
    const response = await agent.get(`/api/conversations/${id}`).expect(200);
    body = conversationResponseSchema.parse(response.body);
    expect(body.latestTurn?.status).toBe('completed');
    expect(body.activeTurn).toBeNull();
  });
  return body!;
}

async function localServer(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fake server address');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe('real application composition', () => {
  it('runs rules, quick answers, corrections, durable plans and authenticated events through the real modules', async () => {
    const app = await fixture();
    const frames: ServerMessage[] = [];
    const socket = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: app.cookie, Origin: 'http://localhost:5173' } });
    cleanup.push(() => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); });
    socket.on('message', raw => frames.push(serverMessageSchema.parse(JSON.parse(raw.toString()))));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'resume', lastEventId: null }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'ready')).toBe(true));
    const created = await app.agent.post('/api/conversations').send({ content: '我和配偶打算明年搬到葡萄牙生活。', clientMessageId: randomUUID(), enginePreference: 'rules' }).expect(201);
    const id = created.body.conversation.id as string;
    const first = await completed(app.agent, id);
    expect(first.conversation.profile.slots.destination.value).toBe('PT');
    expect(first.conversation.profile.slots.applicantNationality.status).toBe('missing');
    const firstPage = messagesResponseSchema.parse((await app.agent.get(`/api/conversations/${id}/messages`).expect(200)).body);
    const firstReply = firstPage.items.find(message => message.role === 'assistant');
    expect(firstReply?.role === 'assistant' && firstReply.payload?.questions.some(question => question.slot === 'applicantNationality')).toBe(true);
    await app.agent.post(`/api/conversations/${id}/messages`).send({ content: '中国', clientMessageId: randomUUID(), payload: { answers: [{ slot: 'applicantNationality', value: 'CN', label: '中国' }] } }).expect(202);
    const quick = await completed(app.agent, id);
    expect(quick.latestTurn?.engineUsed).toBeNull();
    expect(quick.conversation.profile.slots.applicantNationality.value).toBe('CN');
    expect(quick.conversation.profile.slots.partnerNationality.status).toBe('missing');
    await app.agent.post(`/api/conversations/${id}/messages`).send({ content: '配偶是中国籍，没有孩子。', clientMessageId: randomUUID() }).expect(202);
    await completed(app.agent, id);
    await app.agent.post(`/api/conversations/${id}/messages`).send({ content: '不对，配偶是葡萄牙籍。', clientMessageId: randomUUID() }).expect(202);
    const corrected = await completed(app.agent, id);
    expect(corrected.conversation.profile.slots.partnerNationality).toMatchObject({ status: 'known', value: 'PT', previousValue: 'CN', corrected: true });
    expect(corrected.conversation.profile.slots.applicantNationality.value).toBe('CN');
    const invalidRetry = await app.agent.post(`/api/conversations/${id}/turns/${corrected.latestTurn!.id}/retry`).expect(409);
    expect(invalidRetry.body.error.code).toBe('TURN_NOT_RETRYABLE');
    const response = await app.agent.post(`/api/conversations/${id}/plan`).send({ allowIncomplete: true }).expect(201);
    const plan = planResponseSchema.parse(response.body).plan;
    expect(plan.content.coverage).toBe('full');
    expect(plan.content.generatedEarly).toBe(true);
    expect(plan.content.profileSummary.known).toEqual(expect.arrayContaining([{ slot: 'partnerNationality', label: '配偶国籍', display: '葡萄牙' }]));
    expect(plan.content.phases.flatMap(phase => phase.steps).some(step => step.id === plan.content.firstStepId)).toBe(true);
    await vi.waitFor(() => expect(frames.some(frame => frame.type === 'event' && frame.eventType === 'plan.created' && frame.payload.plan.id === plan.id)).toBe(true));
    const forbidden = await app.agent.post(`/api/conversations/${id}/messages`).send({ content: '再补充', clientMessageId: randomUUID() }).expect(409);
    expect(forbidden.body.error.code).toBe('CONVERSATION_COMPLETED');
    const closed = once(socket, 'close');
    await app.agent.post('/api/auth/logout').expect(204);
    expect((await closed)[0]).toBe(4401);
    await app.agent.get('/api/me').expect(401);
    await app.shutdown();
    const restored = await fixture({}, app.databasePath);
    const restoredPlan = planResponseSchema.parse((await restored.agent.get(`/api/plans/${plan.id}`).expect(200)).body).plan;
    expect(restoredPlan).toEqual(plan);
    const history = messagesResponseSchema.parse((await restored.agent.get(`/api/conversations/${id}/messages`).expect(200)).body);
    expect(history.items.map(message => message.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(history.items.filter(message => message.role === 'assistant')).toHaveLength(4);
  });

  it('falls back from a real HTTP fake model through the registered engines', async () => {
    let calls = 0;
    const fake = await localServer((_request, response) => {
      calls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] }));
    });
    const app = await fixture({ LLM_BASE_URL: fake.baseUrl, LLM_API_KEY: 'fake-key', LLM_MODEL: 'fake-model' });
    const created = await app.agent.post('/api/conversations').send({ content: '我是中国籍，想一个人搬到葡萄牙生活。', clientMessageId: randomUUID(), enginePreference: 'remote' }).expect(201);
    const detail = await completed(app.agent, created.body.conversation.id as string);
    expect(calls).toBe(1);
    expect(detail.latestTurn?.engineUsed).toBe('rules');
    expect(detail.latestTurn?.fallbacks).toEqual([{ engine: 'remote', reason: 'invalid_output' }]);
    expect(detail.conversation.profile.slots.applicantNationality.value).toBe('CN');
  });

  it('starts HTTP while local discovery is pending and aborts that discovery during shutdown', async () => {
    let received = false;
    let aborted = false;
    const fake = await localServer((_request, response) => {
      received = true;
      response.once('close', () => { aborted = true; });
    });
    const app = await fixture({ LOCAL_LLM_BASE_URL: fake.baseUrl, LOCAL_LLM_MODEL: 'fake-pending' });
    await app.agent.get('/api/health').expect(200);
    await vi.waitFor(() => expect(received).toBe(true));
    const engines = await app.agent.get('/api/engines').expect(200);
    expect(engines.body.engines).toContainEqual({ id: 'local', available: false, reason: 'unreachable', model: 'fake-pending' });
    await app.shutdown();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('validates knowledge before accepting requests and releases the database after validation failure', () => {
    const directory = temporaryDirectory();
    const source = fileURLToPath(new URL('../../src/knowledge/', import.meta.url));
    copyFileSync(join(source, 'generic.json'), join(directory, 'generic.json'));
    const bad = JSON.parse(readFileSync(join(source, 'portugal.json'), 'utf8')) as { steps: { id: string; dependsOn: string[] }[] };
    bad.steps[0]!.dependsOn = ['missing-step'];
    writeFileSync(join(directory, 'portugal.json'), JSON.stringify(bad));
    const actualLoader = knowledgeLoader.loadKnowledge;
    vi.spyOn(knowledgeLoader, 'loadKnowledge').mockImplementation(() => actualLoader(directory));
    const close = vi.spyOn(AppDatabase.prototype, 'close');
    expect(() => createComposition(loadConfig({ PORT: '0', LLM_API_KEY: '', LOCAL_LLM_MODEL: '', DATABASE_PATH: join(directory, 'failed.sqlite') }))).toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes resources when the configured port is occupied', async () => {
    const occupied = createServer((_request, response) => response.end('occupied'));
    occupied.listen(0);
    await once(occupied, 'listening');
    cleanup.push(() => new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Missing occupied port');
    const directory = temporaryDirectory();
    const config = loadConfig({ PORT: String(address.port), LLM_API_KEY: '', LOCAL_LLM_MODEL: '', DATABASE_PATH: join(directory, 'failed-start.sqlite') });
    const application = createComposition(config);
    cleanup.push(application.shutdown);
    const close = vi.spyOn(application.database, 'close');
    await expect(application.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([1, 3])('preserves attempt %i through graceful shutdown and same-file continuation', async attempt => {
    const app = await fixture({ DEMO_DELAY_MS: '10000' });
    const created = await app.agent.post('/api/conversations').send({ content: '我想一个人搬到葡萄牙生活，我是中国籍。', clientMessageId: randomUUID(), enginePreference: 'rules' }).expect(201);
    const id = created.body.conversation.id as string;
    // Include a task whose previous crash recoveries have used the available recovery budget.
    app.database.prepare('UPDATE turns SET attempt = ? WHERE id = ?').run(attempt, created.body.turn.id);
    await vi.waitFor(async () => {
      const response = await app.agent.get(`/api/conversations/${id}`).expect(200);
      expect(response.body.activeTurn).toMatchObject({ id: created.body.turn.id, status: 'running', attempt });
    });
    await app.shutdown();
    const database = new AppDatabase(app.databasePath);
    expect(database.prepare('SELECT status, attempt FROM turns WHERE id = ?').get(created.body.turn.id)).toEqual({ status: 'queued', attempt });
    expect(database.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'").get()).toEqual({ count: 0 });
    database.close();
    const restored = await fixture({}, app.databasePath);
    const detail = await completed(restored.agent, id);
    expect(detail.latestTurn).toMatchObject({ id: created.body.turn.id, status: 'completed', attempt });
    expect(detail.conversation.profile.slots.destination.value).toBe('PT');
    const messages = await restored.agent.get(`/api/conversations/${id}/messages`).expect(200);
    expect(messages.body.items).toHaveLength(2);
    expect(messages.body.items.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);
  });
});
