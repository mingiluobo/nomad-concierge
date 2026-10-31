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
  const directory = mkdtempSync(join(tmpdir(), 'nc-professional-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const app = createComposition(loadConfig({ PORT: '0', DATABASE_PATH: join(directory, 'app.sqlite'), LLM_API_KEY: '', LOCAL_LLM_MODEL: '' }));
  cleanups.push(app.shutdown);
  await app.start();
  const agent = request.agent(loopbackOrigin(app.server));
  await agent.post('/api/auth/login').send({ username: 'Professional question user' }).expect(200);
  return agent;
}

describe('professional questions through the real application', () => {
  it('answers the visa selection question with professional boundaries and relevant conditions', async () => {
    const agent = await application();
    const created = await agent.post('/api/conversations').send({ content: '我能申请哪个签证', clientMessageId: randomUUID(), enginePreference: 'auto' }).expect(201);
    const id = created.body.conversation.id as string;
    await vi.waitFor(async () => {
      const detail = conversationResponseSchema.parse((await agent.get(`/api/conversations/${id}`).expect(200)).body);
      expect(detail.latestTurn).toMatchObject({ id: created.body.turn.id, status: 'completed', engineUsed: 'rules' });
      expect(detail.activeTurn).toBeNull();
      expect(detail.conversation.profile.slots.goals).toMatchObject({ status: 'known', value: ['residence'] });
    });
    const page = messagesResponseSchema.parse((await agent.get(`/api/conversations/${id}/messages`).expect(200)).body);
    const reply = page.items.find(message => message.role === 'assistant')!;
    expect(reply.payload?.notices.map(notice => notice.kind)).toEqual(['professional']);
    const notice = reply.payload!.notices[0]!;
    expect(notice.text).toContain('需要持牌专业人士根据完整材料判断');
    expect(notice.text).toContain('没办法给出结论');
    expect(notice.conditions).toEqual(expect.arrayContaining([
      { label: '本人国籍', known: false, display: '待了解' },
      { label: '主要收入来源', known: false, display: '待了解' },
      { label: '计划时间', known: false, display: '待了解' },
      { label: '收入证明、无犯罪记录、住所等材料要求', known: false },
    ]));
    expect(reply.content).toContain('需要持牌专业人士确认');
    expect(reply.content).not.toMatch(/你(?:可以|能)申请|符合.{0,20}申请条件|保证.{0,10}获批/);
    expect(reply.payload?.recorded).toContainEqual({ slot: 'goals', label: '诉求', display: '居留' });
    expect(reply.payload?.questions.map(question => question.slot)).toEqual(['destination', 'applicantNationality']);
  });
  it.each([
    { topic: 'visa eligibility', text: '我是中国籍，可以申请签证吗？', slot: 'applicantNationality' as const, value: 'CN', label: '本人国籍', display: '中国', goal: 'residence', unknown: ['主要收入来源', '计划时间'], fixed: '收入证明、无犯罪记录、住所等材料要求' },
    { topic: 'tax amount', text: '收入来自中国，要交多少税？', slot: 'incomeCountry' as const, value: 'CN', label: '主要收入来源国', display: '中国', goal: 'tax', unknown: ['主要收入来源'], fixed: '税务居民身份取决于实际居住时间，以及两国之间的税收协定' },
    { topic: 'company setup', text: '我是中国籍，开公司合法吗？', slot: 'applicantNationality' as const, value: 'CN', label: '本人国籍', display: '中国', goal: 'company', unknown: ['公司业务类型'], fixed: '外国人在目的国开公司，通常还取决于在当地的居留身份' },
  ])('retains facts, professional limits, known and unknown conditions for $topic', async ({ text, slot, value, label, display, goal, unknown, fixed }) => {
    const agent = await application();
    const created = await agent.post('/api/conversations').send({ content: text, clientMessageId: randomUUID(), enginePreference: 'rules' }).expect(201);
    const id = created.body.conversation.id as string;
    await vi.waitFor(async () => {
      const detail = conversationResponseSchema.parse((await agent.get(`/api/conversations/${id}`).expect(200)).body);
      expect(detail.latestTurn).toMatchObject({ id: created.body.turn.id, status: 'completed', engineUsed: 'rules' });
      expect(detail.activeTurn).toBeNull();
      expect(detail.conversation.profile.slots[slot]).toMatchObject({ status: 'known', value });
      expect(detail.conversation.profile.slots.goals).toMatchObject({ status: 'known', value: [goal] });
    });
    const page = messagesResponseSchema.parse((await agent.get(`/api/conversations/${id}/messages`).expect(200)).body);
    const reply = page.items.find(message => message.role === 'assistant')!;
    expect(reply.payload?.notices.map(notice => notice.kind)).toEqual(['professional']);
    const notice = reply.payload!.notices[0]!;
    expect(notice.text).toContain('需要持牌专业人士根据完整材料判断');
    expect(notice.text).toContain('没办法给出结论');
    expect(notice.text).toContain('可能不完整或过时');
    expect(notice.conditions).toContainEqual({ label, known: true, display });
    for (const missing of unknown) expect(notice.conditions).toContainEqual({ label: missing, known: false, display: '待了解' });
    expect(notice.conditions).toContainEqual({ label: fixed, known: false });
    expect(reply.payload?.recorded).toContainEqual({ slot, label, display });
    expect(reply.payload?.recorded.some(item => item.slot === 'goals')).toBe(true);
    expect(reply.content).toContain('需要持牌专业人士确认');
    expect(reply.content).toContain('还需要了解');
    expect(reply.payload?.questions.length).toBeGreaterThan(0);
    expect(reply.content).not.toMatch(/你(?:可以|能)申请|符合.{0,20}申请条件|保证.{0,10}获批|税额(?:为|是)\d/);
  });
});
