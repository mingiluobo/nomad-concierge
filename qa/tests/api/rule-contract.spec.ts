import { test, expect } from '../../fixtures/test.js';
import { slots } from '../../../packages/shared/src/slots.js';
import type { SlotKey } from '../../../packages/shared/src/profile.js';
import type { AssistantPayload } from '../../../packages/shared/src/dto.js';
import { title, login, create, send, settle, reply, answer } from './support.js';

function professional(payload: AssistantPayload, keys: SlotKey[]) {
    const notice = payload.notices.find(item => item.kind === 'professional');
    expect(notice).toBeDefined();
    expect(notice!.text).toMatch(/持牌/);
    expect(notice!.text).toMatch(/没办法给出结论|不能.*结论/);
    expect(notice!.text).toMatch(/演示/);
    expect(notice!.text).toMatch(/不完整|过时/);
    for (const key of keys)
        expect(notice!.conditions).toContainEqual(expect.objectContaining({ label: slots[key].label }));
    expect(notice!.conditions?.some(condition => !condition.known)).toBe(true);
    expect(payload.questions.length).toBeGreaterThan(0);
    return notice!;
}

test(title('API-096'), async ({ api }) => {
    await login(api.request);
    for (const question of [
        '能不能申请签证？', '签证可以申请吗？', '能不能拿到签证？', '我能拿到签证吗？',
        '签证能否获批？', '有没有资格申请签证？', '申请签证符合条件吗？', '签证申请得下来吗？',
    ]) {
        await test.step(question, async () => {
            const made = await create(api.request, `我是中国籍，${question}`);
            const state = await settle(api.request, made.conversation.id);
            expect(state.conversation.profile.slots.applicantNationality.value).toBe('CN');
            expect(state.conversation.profile.slots.goals.value).toEqual(['residence']);
            const notice = professional((await reply(api.request, made.conversation.id)).payload, ['applicantNationality', 'incomeSource', 'timeline']);
            expect(notice.conditions).toContainEqual(expect.objectContaining({ label: slots.applicantNationality.label, known: true, display: expect.stringContaining('中国') }));
            expect(notice.conditions?.map(condition => condition.label).join(' ')).toMatch(/收入证明.*无犯罪记录.*住所/);
        });
    }
});

test(title('API-097'), async ({ api }) => {
    await login(api.request);
    const cases: { background: string; question: string; keys: SlotKey[]; excluded: SlotKey[]; goal: string }[] = [
        { background: '我想开公司', question: '我是中国籍，能不能申请签证？', keys: ['applicantNationality', 'incomeSource', 'timeline'], excluded: ['businessType', 'incomeCountry'], goal: 'residence' },
        { background: '我想申请签证', question: '公司业务是软件技术，要交多少税？', keys: ['incomeCountry', 'incomeSource'], excluded: ['businessType', 'applicantNationality'], goal: 'tax' },
        { background: '我想了解税务', question: '我是中国籍，开公司合法吗？', keys: ['businessType', 'applicantNationality'], excluded: ['incomeCountry', 'incomeSource'], goal: 'company' },
    ];
    for (const row of cases) {
        const made = await create(api.request, row.background);
        await settle(api.request, made.conversation.id);
        await send(api.request, made.conversation.id, row.question);
        const state = await settle(api.request, made.conversation.id);
        expect(state.conversation.profile.slots.goals.value).toContain(row.goal);
        const notice = professional((await reply(api.request, made.conversation.id)).payload, row.keys);
        for (const key of row.excluded)
            expect(notice.conditions?.map(condition => condition.label)).not.toContain(slots[key].label);
        if (row.question.includes('中国籍')) expect(state.conversation.profile.slots.applicantNationality.value).toBe('CN');
        else expect(state.conversation.profile.slots.businessType.value).toBe('software');
    }
});

test(title('API-098'), async ({ api }) => {
    await login(api.request);
    const cases = [
        { text: '我是中国籍，能不能申请葡萄牙签证？', known: { applicantNationality: 'CN' } },
        { text: '我和配偶都是中国籍，能不能申请葡萄牙签证？', known: { applicantNationality: 'CN', partnerNationality: 'CN' } },
        { text: '收入来自中国，能不能申请葡萄牙签证？', known: { incomeCountry: 'CN' } },
    ];
    for (const row of cases) {
        const made = await create(api.request, row.text);
        const state = await settle(api.request, made.conversation.id);
        expect(state.conversation.profile.slots.destination.value).toBe('PT');
        for (const key of ['applicantNationality', 'partnerNationality', 'incomeCountry'] as const) {
            const expected = (row.known as Partial<Record<SlotKey, string>>)[key];
            expect(state.conversation.profile.slots[key]).toMatchObject(expected ? { status: 'known', value: expected } : { status: 'missing' });
            expect(state.conversation.profile.slots[key].value).not.toBe('PT');
        }
        professional((await reply(api.request, made.conversation.id)).payload, ['applicantNationality', 'incomeSource', 'timeline']);
    }
});

test(title('API-099'), async ({ api }) => {
    await login(api.request);
    for (const text of ['我想申请签证', '我想申请葡萄牙签证']) {
        const made = await create(api.request, text);
        const state = await settle(api.request, made.conversation.id);
        expect(state.conversation.profile.slots.goals.value).toEqual(['residence']);
        if (text.includes('葡萄牙')) expect(state.conversation.profile.slots.destination.value).toBe('PT');
        const payload = (await reply(api.request, made.conversation.id)).payload;
        expect(payload.notices.map(notice => notice.kind)).not.toContain('professional');
        expect(payload.notices.map(notice => notice.kind)).not.toContain('off_topic');
        expect(payload.questions.length).toBeGreaterThan(0);
    }
});

test(title('API-100'), async ({ api }) => {
    await login(api.request);
    const made = await create(api.request, '我想了解税务');
    const cid = made.conversation.id;
    await settle(api.request, cid);
    await send(api.request, cid, '两个孩子', [answer('childrenCount', 2)]);
    await settle(api.request, cid);
    const facts: { text: string; slot: SlotKey; value: unknown }[] = [
        { text: '已经有医疗保险', slot: 'hasHealthInsurance', value: true },
        { text: '公司业务是软件技术', slot: 'businessType', value: 'software' },
        { text: '孩子偏好公立学校', slot: 'schoolPreference', value: 'public' },
    ];
    for (const fact of facts) {
        const sent = await send(api.request, cid, fact.text);
        const state = await settle(api.request, cid);
        expect(state.conversation.profile.slots.goals.value).toEqual(['tax']);
        expect(state.conversation.profile.slots[fact.slot]).toMatchObject({ status: 'known', value: fact.value, sourceMessageId: sent.message.id });
    }
});

test(title('API-101'), async ({ api }) => {
    await login(api.request);
    for (const prefix of ['只想', '只要', '改成']) {
        const made = await create(api.request, '我想了解税务');
        const cid = made.conversation.id;
        await settle(api.request, cid);
        await send(api.request, cid, '已有诉求和家庭信息', [answer('goals', ['residence', 'company', 'tax', 'education', 'healthcare']), answer('childrenCount', 2)]);
        await settle(api.request, cid);
        await send(api.request, cid, `${prefix}了解税务，已经有医疗保险，公司业务是软件技术，孩子偏好公立学校`);
        const state = await settle(api.request, cid);
        expect(state.conversation.profile.slots.goals).toMatchObject({ value: ['tax'], corrected: true });
        expect(state.conversation.profile.slots).toMatchObject({
            hasHealthInsurance: { status: 'known', value: true },
            businessType: { status: 'known', value: 'software' },
            schoolPreference: { status: 'known', value: 'public' },
        });
        const last = (await reply(api.request, cid)).payload;
        expect(last.corrections).toContainEqual(expect.objectContaining({ slot: 'goals', to: '税务' }));
    }
});

test(title('API-102'), async ({ api }) => {
    await login(api.request);
    const made = await create(api.request, '我想了解税务');
    const cid = made.conversation.id;
    await settle(api.request, cid);
    const cases = [
        ['下周', 'lt3m'], ['两个月后', 'lt3m'], ['三个月内', 'lt3m'],
        ['三个月后', '3to6m'], ['四个月后', '3to6m'], ['半年后', '6to12m'],
        ['一年后', 'gt12m'], ['一年以后', 'gt12m'],
        ['明年', '6to12m'], ['下个月', 'lt3m'], ['尽快', 'lt3m'], ['半年内', '3to6m'],
    ] as const;
    for (const [phrase, expected] of cases) {
        await test.step(`${phrase} → ${expected}`, async () => {
            await send(api.request, cid, `计划${phrase}出发`);
            const state = await settle(api.request, cid);
            expect(state.conversation.profile.slots.timeline).toMatchObject({ status: 'known', value: expected });
            const payload = (await reply(api.request, cid)).payload;
            expect(payload.questions.map(question => question.slot)).not.toContain('timeline');
            expect(payload.notices.map(notice => notice.kind)).not.toContain('off_topic');
        });
    }
});
