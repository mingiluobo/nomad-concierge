import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationResponseSchema, messagesResponseSchema } from '@nomad/shared';
import { createComposition } from '../../src/composition.js';
import { loadConfig } from '../../src/config.js';
import { loopbackOrigin } from '../helpers/http.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
async function application() {
  const directory = mkdtempSync(join(tmpdir(), 'nc-short-answers-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = createComposition(loadConfig({ PORT: '0', DATABASE_PATH: join(directory, 'app.sqlite'), LLM_API_KEY: '', LOCAL_LLM_MODEL: '' }));
  cleanups.push(app.shutdown);
  await app.start();
  const agent = request.agent(loopbackOrigin(app.server));
  await agent.post('/api/auth/login').send({ username: 'Short answer user' }).expect(200);
  return agent;
}
async function completed(agent: ReturnType<typeof request.agent>, id: string, turnId: string) {
  let detail: ReturnType<typeof conversationResponseSchema.parse> | undefined;
  await vi.waitFor(async () => {
    detail = conversationResponseSchema.parse((await agent.get(`/api/conversations/${id}`).expect(200)).body);
    expect(detail.latestTurn).toMatchObject({ id: turnId, status: 'completed', engineUsed: 'rules' });
    expect(detail.activeTurn).toBeNull();
  });
  const page = messagesResponseSchema.parse((await agent.get(`/api/conversations/${id}/messages`).expect(200)).body);
  return { detail: detail!, reply: page.items.filter(message => message.role === 'assistant').at(-1)! };
}

describe('short answers through the real application', () => {
  it.each([
    ['2', 'not_understood'], ['嗯', 'not_understood'], ['好', 'not_understood'],
    ['行', 'not_understood'], ['好的', 'not_understood'],
    ['今天午饭吃什么', 'off_topic'], ['唱歌', 'off_topic'],
  ])('uses the %s reply path without changing profile information', async (answer, notice) => {
    const agent = await application();
    const created = await agent.post('/api/conversations').send({
      content: '我一个人搬到葡萄牙生活，我是中国籍，没有孩子，目前在中国，是公民。',
      clientMessageId: randomUUID(), enginePreference: 'rules',
    }).expect(201);
    const id = created.body.conversation.id as string;
    const first = await completed(agent, id, created.body.turn.id as string);
    expect(first.detail.conversation.profile.pendingSlots).toEqual(['timeline', 'incomeSource']);
    const sent = await agent.post(`/api/conversations/${id}/messages`).send({ content: answer, clientMessageId: randomUUID() }).expect(202);
    const { detail, reply } = await completed(agent, id, sent.body.turn.id as string);
    expect(detail.conversation.profile).toEqual(first.detail.conversation.profile);
    expect(reply.payload?.recorded).toEqual([]);
    expect(reply.payload?.notices.map(item => item.kind)).toEqual([notice]);
    expect(reply.payload?.questions.map(question => question.slot)).toEqual(['timeline', 'incomeSource']);
    expect(reply.content).toContain('还需要了解');
    expect(detail.conversation.status).toBe('collecting');
    if (notice === 'not_understood') expect(reply.content).toContain('没能从这句话里识别出新的信息');
  });
  it('keeps a bare numeric opening off-topic before the first questions exist', async () => {
    const agent = await application();
    const created = await agent.post('/api/conversations').send({ content: '2', clientMessageId: randomUUID(), enginePreference: 'rules' }).expect(201);
    const { reply } = await completed(agent, created.body.conversation.id as string, created.body.turn.id as string);
    expect(reply.payload?.notices.map(notice => notice.kind)).toEqual(['off_topic']);
    expect(reply.payload?.recorded).toEqual([]);
    expect(reply.payload?.questions.map(question => question.slot)).toEqual(['destination', 'goals']);
  });
});
