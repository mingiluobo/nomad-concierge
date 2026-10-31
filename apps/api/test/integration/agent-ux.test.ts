import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationResponseSchema, messagesResponseSchema, planResponseSchema } from '@nomad/shared';
import { createComposition } from '../../src/composition.js';
import { loadConfig } from '../../src/config.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });
async function application() {
  const directory = mkdtempSync(join(tmpdir(), 'nc-ux-rules-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = createComposition(loadConfig({ PORT: '0', DATABASE_PATH: join(directory, 'app.sqlite'), LLM_API_KEY: '', LOCAL_LLM_MODEL: '' }));
  cleanups.push(app.shutdown); await app.start();
  const agent = request.agent(app.server);
  await agent.post('/api/auth/login').send({ username: 'Rule experience user' }).expect(200);
  return agent;
}
async function completed(agent: ReturnType<typeof request.agent>, id: string, turnId: string) {
  let detail: ReturnType<typeof conversationResponseSchema.parse> | undefined;
  await vi.waitFor(async () => {
    detail = conversationResponseSchema.parse((await agent.get(`/api/conversations/${id}`).expect(200)).body);
    expect(detail.latestTurn).toMatchObject({ id: turnId, status: 'completed', engineUsed: 'rules' });
    expect(detail.activeTurn).toBeNull();
  });
  const messages = messagesResponseSchema.parse((await agent.get(`/api/conversations/${id}/messages`).expect(200)).body);
  return { detail: detail!, reply: messages.items.filter(message => message.role === 'assistant').at(-1)! };
}
async function start(agent: ReturnType<typeof request.agent>, content: string) {
  const created = await agent.post('/api/conversations').send({ content, clientMessageId: randomUUID(), enginePreference: 'rules' }).expect(201);
  return { id: created.body.conversation.id as string, ...await completed(agent, created.body.conversation.id as string, created.body.turn.id as string) };
}

describe('UX05 real professional replies', () => {
  it.each(['我是中国籍，我能拿到签证吗？', '我是中国籍，有资格申请葡萄牙签证吗？', '收入来自中国，我该缴多少税？', '我是中国籍，我能注册公司吗？'])('retains information, boundaries and questions for %s', async text => {
    const agent = await application(); const { detail, reply } = await start(agent, text);
    expect(reply.payload?.notices.map(notice => notice.kind)).toEqual(['professional']);
    const notice = reply.payload!.notices[0]!;
    expect(notice.text).toContain('没办法给出结论'); expect(notice.text).toContain('可能不完整或过时');
    expect(notice.conditions?.some(condition => condition.known && condition.display === '中国')).toBe(true);
    expect(notice.conditions?.some(condition => !condition.known)).toBe(true);
    expect(reply.content).toContain('需要持牌专业人士确认'); expect(reply.content).toContain('还需要了解');
    expect(reply.payload?.recorded.length).toBeGreaterThan(0);
    if (text.includes('葡萄牙')) expect(detail.conversation.profile.slots.destination).toMatchObject({ status: 'known', value: 'PT' });
  });
  it('uses tax conditions for a relief eligibility question while preserving income facts', async () => {
    const agent = await application(); const { detail, reply } = await start(agent, '我是自由职业者，我能享受税收优惠吗？');
    expect(detail.conversation.profile.slots.incomeSource).toMatchObject({ status: 'known', value: 'freelancer' });
    expect(reply.payload?.notices.map(notice => notice.kind)).toEqual(['professional']);
    expect(reply.payload?.notices[0]?.conditions).toContainEqual({ label: '主要收入来源', known: true, display: '自由职业' });
    expect(reply.payload?.notices[0]?.conditions).toContainEqual({ label: '主要收入来源国', known: false, display: '待了解' });
    expect(reply.content).toContain('没办法给出结论');
    expect(reply.content).toContain('还需要了解');
  });
});

describe('UX04 real scope and fact applicability', () => {
  it('preserves insurance as an applicable fact in a tax-only conversation and plan', async () => {
    const agent = await application();
    const first = await start(agent, '只想了解税务，已经有医疗保险');
    expect(first.detail.conversation.profile.slots.goals.value).toEqual(['tax']);
    expect(first.detail.conversation.profile.slots.hasHealthInsurance).toMatchObject({ status: 'known', value: true });
    expect(first.reply.payload?.recorded).toContainEqual(expect.objectContaining({ slot: 'hasHealthInsurance', display: '已有' }));
    const sent = await agent.post(`/api/conversations/${first.id}/messages`).send({ content: '我是中国籍，去葡萄牙', clientMessageId: randomUUID() }).expect(202);
    const latest = await completed(agent, first.id, sent.body.turn.id as string);
    expect(latest.detail.conversation.profile.slots.goals.value).toEqual(['tax']);
    expect(latest.detail.conversation.profile.slots.hasHealthInsurance).toMatchObject({ status: 'known', value: true });
    const plan = planResponseSchema.parse((await agent.post(`/api/conversations/${first.id}/plan`).send({ allowIncomplete: true }).expect(201)).body).plan;
    expect(plan.content.profileSummary.known).toContainEqual(expect.objectContaining({ slot: 'hasHealthInsurance', display: '已有' }));
  });
});

describe('UX03 real departure time replies', () => {
  it.each([['计划半年后出发', '6to12m'], ['三个月后出发', '3to6m'], ['三个月内出发', 'lt3m']])('records %s without off-topic guidance', async (text, value) => {
    const agent = await application(); const { detail, reply } = await start(agent, text);
    expect(detail.conversation.profile.slots.timeline).toMatchObject({ status: 'known', value });
    expect(reply.payload?.notices.some(notice => notice.kind === 'off_topic')).toBe(false);
  });
  it('re-asks the pending time when departure wording has no supported interval', async () => {
    const agent = await application();
    const first = await start(agent, '我一个人搬到葡萄牙生活，我是中国籍，没有孩子，目前在中国，是公民，我是自由职业者');
    expect(first.detail.conversation.profile.pendingSlots).toEqual(['timeline']);
    const sent = await agent.post(`/api/conversations/${first.id}/messages`).send({ content: '等事情处理完再出发', clientMessageId: randomUUID() }).expect(202);
    const { detail, reply } = await completed(agent, first.id, sent.body.turn.id as string);
    expect(detail.conversation.profile.slots.timeline.status).toBe('missing');
    expect(reply.payload?.notices.map(notice => notice.kind)).toEqual(['not_understood']);
    expect(reply.payload?.questions.map(question => question.slot)).toEqual(['timeline']);
  });
});
