import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures/test.js';
import type { SlotKey } from '../../../packages/shared/src/profile.js';
import { title, login, create, send, settle, detail, reply, answer, seeded } from './support.js';

// Expected mappings are copied from the candidate's public country contract, not interpreter output.
const addedAliases: [alias: string, code: string, display: string][] = [
    ['葡萄牙共和国', 'PT', '葡萄牙'], ['西班牙王国', 'ES', '西班牙'],
    ['法兰西', 'FR', '法国'], ['法兰西共和国', 'FR', '法国'],
    ['德意志', 'DE', '德国'], ['德意志联邦共和国', 'DE', '德国'],
    ['意大利共和国', 'IT', '意大利'], ['荷兰王国', 'NL', '荷兰'], ['尼德兰王国', 'NL', '荷兰'],
    ['比利时王国', 'BE', '比利时'], ['奥地利共和国', 'AT', '奥地利'], ['爱尔兰共和国', 'IE', '爱尔兰'],
    ['丹麦王国', 'DK', '丹麦'], ['瑞典王国', 'SE', '瑞典'], ['芬兰共和国', 'FI', '芬兰'],
    ['希腊共和国', 'GR', '希腊'], ['波兰共和国', 'PL', '波兰'], ['捷克共和国', 'CZ', '捷克'],
    ['保加利亚共和国', 'BG', '保加利亚'], ['克罗地亚共和国', 'HR', '克罗地亚'],
    ['斯洛伐克共和国', 'SK', '斯洛伐克'], ['斯洛文尼亚共和国', 'SI', '斯洛文尼亚'],
    ['爱沙尼亚共和国', 'EE', '爱沙尼亚'], ['拉脱维亚共和国', 'LV', '拉脱维亚'],
    ['立陶宛共和国', 'LT', '立陶宛'], ['卢森堡大公国', 'LU', '卢森堡'],
    ['马耳他共和国', 'MT', '马耳他'], ['塞浦路斯共和国', 'CY', '塞浦路斯'],
    ['挪威王国', 'NO', '挪威'], ['冰岛共和国', 'IS', '冰岛'],
    ['列支敦士登公国', 'LI', '列支敦士登'], ['瑞士联邦', 'CH', '瑞士'],
    ['大不列颠', 'GB', '英国'], ['大不列颠及北爱尔兰联合王国', 'GB', '英国'], ['大不列颠和北爱尔兰联合王国', 'GB', '英国'],
    ['美利坚', 'US', '美国'], ['美利坚合众国', 'US', '美国'], ['澳大利亚联邦', 'AU', '澳大利亚'],
    ['纽西兰', 'NZ', '新西兰'], ['日本国', 'JP', '日本'], ['大韩民国', 'KR', '韩国'],
    ['新加坡共和国', 'SG', '新加坡'], ['狮城', 'SG', '新加坡'], ['泰王国', 'TH', '泰国'],
    ['阿拉伯联合酋长国', 'AE', '阿联酋'], ['智利共和国', 'CL', '智利'], ['巴西联邦共和国', 'BR', '巴西'],
];
const countrySlots: SlotKey[] = ['destination', 'applicantNationality', 'partnerNationality', 'currentResidence', 'incomeCountry'];
async function pendingCountries(request: APIRequestContext) {
    const made = await create(request, '我想了解税务');
    const state = await settle(request, made.conversation.id);
    expect(state.conversation.profile.pendingSlots).toEqual(['destination', 'applicantNationality']);
    return made.conversation.id;
}

test(title('API-104'), async ({ api }) => {
    test.setTimeout(120000);
    await login(api.request);
    const cid = await pendingCountries(api.request);
    for (const [alias, code, display] of addedAliases) {
        await test.step(`${alias} → ${code}`, async () => {
            // Reset to a different country so failure to recognize an alias cannot pass as a same-value update.
            await send(api.request, cid, '重置目的国', [answer('destination', code === 'JP' ? 'PT' : 'JP')]);
            await settle(api.request, cid);
            const sent = await send(api.request, cid, `我打算去${alias}生活`);
            const state = await settle(api.request, cid);
            expect.soft(state.conversation.profile.slots.destination, alias).toMatchObject({ status: 'known', value: code, sourceMessageId: sent.message.id });
            const last = (await reply(api.request, cid)).payload;
            expect.soft(last.corrections, alias).toContainEqual(expect.objectContaining({ slot: 'destination', to: display }));
        });
    }
    const contexts: { text: string; slot: SlotKey; code: string }[] = [
        { text: '我的国籍是美利坚合众国', slot: 'applicantNationality', code: 'US' },
        { text: '我和配偶同行，配偶国籍是法兰西共和国', slot: 'partnerNationality', code: 'FR' },
        { text: '现在住在德意志联邦共和国', slot: 'currentResidence', code: 'DE' },
        { text: '收入来自大不列颠', slot: 'incomeCountry', code: 'GB' },
        { text: '我想申请美利坚合众国签证', slot: 'destination', code: 'US' },
    ];
    for (const row of contexts) {
        await test.step(row.text, async () => {
            const contextId = await pendingCountries(api.request);
            const before = await detail(api.request, contextId);
            const sent = await send(api.request, contextId, row.text);
            const state = await settle(api.request, contextId);
            expect.soft(state.conversation.profile.slots[row.slot]).toMatchObject({ status: 'known', value: row.code, sourceMessageId: sent.message.id });
            for (const other of countrySlots.filter(slot => slot !== row.slot))
                expect.soft(state.conversation.profile.slots[other], `${row.text}: ${other}`).toEqual(before.conversation.profile.slots[other]);
        });
    }
});

test(title('API-105'), async ({ api }) => {
    await login(api.request);
    for (const content of ['参加国际会议', '大马士革', '加国', '大马']) {
        await test.step(`不把 ${content} 映射到国家`, async () => {
            const cid = await pendingCountries(api.request);
            const before = await detail(api.request, cid);
            await send(api.request, cid, content);
            const state = await settle(api.request, cid);
            for (const slot of countrySlots)
                expect.soft(state.conversation.profile.slots[slot], `${content}: ${slot}`).toEqual(before.conversation.profile.slots[slot]);
        });
    }
    for (const [content, code] of [['加拿大', 'CA'], ['马来西亚', 'MY']] as const) {
        const cid = await pendingCountries(api.request);
        await send(api.request, cid, content);
        const state = await settle(api.request, cid);
        expect.soft(state.conversation.profile.slots.destination).toMatchObject({ status: 'known', value: code });
        expect.soft(state.conversation.profile.slots.applicantNationality.status).toBe('missing');
    }
});

test(title('API-106'), async ({ api }) => {
    await login(api.request);
    const cid = await pendingCountries(api.request);
    const before = await detail(api.request, cid);
    for (const content of ['2', '嗯', '好的']) {
        await test.step(`有追问：${content}`, async () => {
            await send(api.request, cid, content);
            const state = await settle(api.request, cid);
            const last = (await reply(api.request, cid)).payload;
            expect.soft(state.conversation.profile).toEqual(before.conversation.profile);
            expect.soft(last.notices.map(notice => notice.kind)).toContain('not_understood');
            expect.soft(last.notices.map(notice => notice.kind)).not.toContain('off_topic');
            expect.soft(last.recorded).toEqual([]);
            expect.soft(last.corrections).toEqual([]);
            expect.soft(last.questions.map(question => question.slot)).toEqual(before.conversation.profile.pendingSlots);
        });
    }
});

test(title('API-107'), async ({ api }) => {
    const cid = await seeded(api.request);
    const before = await detail(api.request, cid);
    expect(before.conversation.progress.isComplete).toBe(true);
    expect(before.conversation.profile.pendingSlots).toEqual([]);
    expect((await reply(api.request, cid)).payload.questions).toEqual([]);
    for (const content of ['2', '嗯', '好的']) {
        await test.step(`无追问：${content}`, async () => {
            await send(api.request, cid, content);
            const state = await settle(api.request, cid);
            const last = (await reply(api.request, cid)).payload;
            expect.soft(state.conversation.profile).toEqual(before.conversation.profile);
            expect.soft(last.notices.map(notice => notice.kind)).toContain('off_topic');
            expect.soft(last.notices.map(notice => notice.kind)).not.toContain('not_understood');
            expect.soft(last.recorded).toEqual([]);
            expect.soft(last.questions).toEqual([]);
        });
    }
});

test(title('API-108'), async ({ api }) => {
    await login(api.request);
    const made = await create(api.request);
    const cid = made.conversation.id;
    const before = await settle(api.request, cid);
    expect(before.conversation.profile.pendingSlots.length).toBeGreaterThan(0);
    for (const content of ['今天午饭吃什么', '唱歌', '吃啥']) {
        await test.step(`明确无关：${content}`, async () => {
            await send(api.request, cid, content);
            const state = await settle(api.request, cid);
            const last = (await reply(api.request, cid)).payload;
            expect.soft(state.conversation.profile).toEqual(before.conversation.profile);
            expect.soft(last.notices.map(notice => notice.kind)).toContain('off_topic');
            expect.soft(last.notices.map(notice => notice.kind)).not.toContain('not_understood');
            expect.soft(last.questions.map(question => question.slot)).toEqual(before.conversation.profile.pendingSlots);
        });
    }
    await send(api.request, cid, '中国');
    expect((await settle(api.request, cid)).conversation.profile.slots.applicantNationality.value).toBe('CN');
    await send(api.request, cid, '一个人');
    const single = await settle(api.request, cid);
    expect(single.conversation.profile.slots.hasPartner.value).toBe(false);
    expect((await reply(api.request, cid)).payload.questions[0]!.slot).toBe('childrenCount');
    await send(api.request, cid, '两个');
    const children = await settle(api.request, cid);
    expect(children.conversation.profile.slots.childrenCount.value).toBe(2);
    expect(children.conversation.profile.slots.destination.value).toBe('PT');
    const last = (await reply(api.request, cid)).payload;
    expect(last.notices.map(notice => notice.kind)).not.toContain('not_understood');
    expect(last.notices.map(notice => notice.kind)).not.toContain('off_topic');
});
