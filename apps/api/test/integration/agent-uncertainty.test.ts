import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { loopbackOrigin } from '../helpers/http.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationResponseSchema, messagesResponseSchema } from '@nomad/shared';
import { createComposition } from '../../src/composition.js';
import { loadConfig } from '../../src/config.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

async function application() {
  const directory = mkdtempSync(join(tmpdir(), 'nc-uncertainty-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = createComposition(loadConfig({ PORT: '0', DATABASE_PATH: join(directory, 'app.sqlite'), LLM_API_KEY: '', LOCAL_LLM_MODEL: '' }));
  cleanups.push(app.shutdown);
  await app.start();
  const agent = request.agent(loopbackOrigin(app.server));
  await agent.post('/api/auth/login').send({ username: 'Uncertainty user' }).expect(200);
  return agent;
}

async function completed(agent: ReturnType<typeof request.agent>, conversationId: string, turnId: string) {
  let detail: ReturnType<typeof conversationResponseSchema.parse> | undefined;
  await vi.waitFor(async () => {
    detail = conversationResponseSchema.parse((await agent.get(`/api/conversations/${conversationId}`).expect(200)).body);
    expect(detail.latestTurn).toMatchObject({ id: turnId, status: 'completed', engineUsed: 'rules' });
    expect(detail.activeTurn).toBeNull();
  });
  return detail!;
}

describe('uncertainty replies through the real application', () => {
  it.each([
    { context: 'no previous questions', seed: '', answer: '没想好', pending: [] },
    { context: 'multiple eligible questions', seed: '我一个人搬到葡萄牙生活，我是中国籍，没有孩子，目前在中国，是公民。', answer: '不知道', pending: ['timeline', 'incomeSource'] },
    { context: 'one question forbidding uncertainty', seed: '我一个人搬到葡萄牙生活，没有孩子，目前在中国，是公民，明年出发，我是自由职业者。', answer: '不确定', pending: ['applicantNationality'] },
  ])('re-asks without an off-topic notice with $context', async ({ seed, answer, pending }) => {
    const agent = await application();
    const created = await agent.post('/api/conversations').send({ content: seed || answer, clientMessageId: randomUUID(), enginePreference: 'rules' }).expect(201);
    const id = created.body.conversation.id as string;
    let detail = await completed(agent, id, created.body.turn.id as string);
    if (seed) {
      expect(detail.conversation.profile.pendingSlots).toEqual(pending);
      const before = detail.conversation.profile;
      const sent = await agent.post(`/api/conversations/${id}/messages`).send({ content: answer, clientMessageId: randomUUID() }).expect(202);
      detail = await completed(agent, id, sent.body.turn.id as string);
      expect(detail.conversation.profile).toEqual(before);
    }
    const page = messagesResponseSchema.parse((await agent.get(`/api/conversations/${id}/messages`).expect(200)).body);
    const reply = page.items.filter(message => message.role === 'assistant').at(-1)!;
    expect(reply.payload?.notices.map(notice => notice.kind)).toEqual(['not_understood']);
    expect(reply.payload?.notices.some(notice => notice.kind === 'off_topic')).toBe(false);
    expect(reply.content).toContain('没能从这句话里识别出新的信息');
    expect(reply.content).toContain('还需要了解');
    expect(reply.payload?.recorded).toEqual([]);
    expect(reply.payload?.questions.map(question => question.slot)).toEqual(seed ? pending : ['destination', 'goals']);
    expect(detail.conversation.status).toBe('collecting');
  });
});
