import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { conversationResponseSchema, messagesResponseSchema } from '@nomad/shared';
import { createComposition } from '../../src/composition.js';
import { loadConfig } from '../../src/config.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

describe('professional questions through the real application', () => {
  it('answers the visa selection question with professional boundaries and relevant conditions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nc-professional-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const app = createComposition(loadConfig({ PORT: '0', DATABASE_PATH: join(directory, 'app.sqlite'), LLM_API_KEY: '', LOCAL_LLM_MODEL: '' }));
    cleanups.push(app.shutdown);
    await app.start();
    const agent = request.agent(app.server);
    await agent.post('/api/auth/login').send({ username: 'Professional question user' }).expect(200);
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
});
