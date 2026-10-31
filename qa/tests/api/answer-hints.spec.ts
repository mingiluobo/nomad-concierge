import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures/test.js';
import { enginesResponseSchema, turnResponseSchema } from '../../../packages/shared/src/dto.js';
import type { SlotKey } from '../../../packages/shared/src/profile.js';
import type { AppInstance } from '../../harness/app.js';
import { title, id, login, create, send, settle, detail, answer, parsed, error, waitRunning } from './support.js';
import { hinted, raw, rawMessages, modelCalls, promptContext, expectPendingQuestions } from './context-support.js';

async function fresh(request: APIRequestContext) {
    const made = await create(request, '我想了解税务');
    await settle(request, made.conversation.id);
    return made.conversation.id;
}
async function unchanged(request: APIRequestContext, cid: string, before: Awaited<ReturnType<typeof detail>>, history: Awaited<ReturnType<typeof rawMessages>>) {
    expect(await detail(request, cid)).toEqual(before);
    expect((await rawMessages(request, cid)).items).toEqual(history.items);
}

test(title('API-083'), async ({ api }) => {
    await login(api.request);
    const cid = await fresh(api.request);
    const before = await detail(api.request, cid), history = await rawMessages(api.request, cid);
    for (const answeringSlot of ['notASlot', '', null, 42]) {
        await error(await api.request.post(`/api/conversations/${cid}/messages`, {
            data: { content: '日本', clientMessageId: id(), payload: { answeringSlot } },
        }), 422, 'VALIDATION_ERROR');
    }
    await unchanged(api.request, cid, before, history);
});

test(title('API-084'), async ({ api }) => {
    await login(api.request);
    const cid = await fresh(api.request);
    const before = await detail(api.request, cid), history = await rawMessages(api.request, cid);
    for (const content of ['', '  \n\t  ']) {
        await error(await api.request.post(`/api/conversations/${cid}/messages`, {
            data: { content, clientMessageId: id(), payload: { answeringSlot: 'applicantNationality' } },
        }), 422, 'VALIDATION_ERROR');
    }
    await unchanged(api.request, cid, before, history);
});

test(title('API-085'), async ({ api }) => {
    await login(api.request);
    const cid = await fresh(api.request);
    const before = await detail(api.request, cid), history = await rawMessages(api.request, cid);
    for (const answers of [[answer('applicantNationality', 'JP')], []]) {
        await error(await api.request.post(`/api/conversations/${cid}/messages`, {
            data: { content: '日本', clientMessageId: id(), payload: { answeringSlot: 'applicantNationality', answers } },
        }), 422, 'VALIDATION_ERROR');
    }
    await unchanged(api.request, cid, before, history);
});

test(title('API-086'), async ({ api }) => {
    await login(api.request);
    const countries: SlotKey[] = ['destination', 'applicantNationality', 'partnerNationality', 'currentResidence', 'incomeCountry'];
    for (const answeringSlot of countries) {
        await test.step(`短回答 → ${answeringSlot}`, async () => {
            const cid = await fresh(api.request);
            await send(api.request, cid, '伴侣同行', [answer('hasPartner', true)]);
            const before = await settle(api.request, cid);
            const sent = await hinted(api.request, cid, '日本', answeringSlot);
            const state = await settle(api.request, cid);
            expect(state.conversation.profile.slots[answeringSlot]).toMatchObject({ status: 'known', value: 'JP', sourceMessageId: sent.message.id });
            for (const other of countries.filter(key => key !== answeringSlot))
                expect(state.conversation.profile.slots[other]).toEqual(before.conversation.profile.slots[other]);
        });
    }
});

test(title('API-087'), async ({ api }) => {
    await login(api.request);
    const cases: { hint: SlotKey; text: string; target: SlotKey; value: string }[] = [
        { hint: 'applicantNationality', text: '现在住在日本', target: 'currentResidence', value: 'JP' },
        { hint: 'destination', text: '我是日本籍', target: 'applicantNationality', value: 'JP' },
        { hint: 'incomeCountry', text: '想申请葡萄牙签证', target: 'destination', value: 'PT' },
    ];
    for (const row of cases) {
        const cid = await fresh(api.request);
        const before = await detail(api.request, cid);
        const sent = await hinted(api.request, cid, row.text, row.hint);
        const state = await settle(api.request, cid);
        expect(state.conversation.profile.slots[row.target]).toMatchObject({ value: row.value, sourceMessageId: sent.message.id });
        expect(state.conversation.profile.slots[row.hint]).toEqual(before.conversation.profile.slots[row.hint]);
    }
});

test(title('API-088'), async ({ api }) => {
    await login(api.request);
    const cid = await fresh(api.request);
    await hinted(api.request, cid, '不知道', 'timeline');
    const unsure = await settle(api.request, cid);
    expect(unsure.conversation.profile.slots.timeline.status).toBe('unsure');
    expect(unsure.conversation.profile.slots.destination.status).toBe('missing');
    await hinted(api.request, cid, '不知道', 'applicantNationality');
    const required = await settle(api.request, cid);
    expect(required.conversation.profile.slots.applicantNationality.status).toBe('missing');
    expect(required.conversation.profile.slots.timeline.status).toBe('unsure');
});

test(title('API-089'), async ({ api, app }) => {
    await login(api.request);
    const cid = await fresh(api.request);
    const clientMessageId = id();
    const sent = await hinted(api.request, cid, '日本', 'applicantNationality', clientMessageId);
    expect(sent.message).toMatchObject({ role: 'user', content: '日本', clientMessageId, payload: { answeringSlot: 'applicantNationality' } });
    await settle(api.request, cid);
    const history = await rawMessages(api.request, cid);
    expect(history.items.find(message => message.id === sent.message.id)).toEqual(sent.message);
    await app.restart();
    expect((await rawMessages(api.request, cid)).items).toEqual(history.items);
    expect((await detail(api.request, cid)).conversation.profile.slots.applicantNationality.value).toBe('JP');
});

test(title('API-090'), async ({ api }) => {
    await login(api.request);
    const cid = await fresh(api.request), clientMessageId = id();
    const [first, duplicate] = await Promise.all([
        hinted(api.request, cid, '日本', 'applicantNationality', clientMessageId, [200, 202]),
        hinted(api.request, cid, '日本', 'applicantNationality', clientMessageId, [200, 202]),
    ]);
    expect(duplicate.message).toEqual(first.message);
    // A replay after the first task finishes may legitimately return turn=null (§9.4).
    const returnedTurnIds = [first.turn?.id, duplicate.turn?.id].filter((value): value is string => Boolean(value));
    expect(new Set(returnedTurnIds).size).toBe(1);
    const completed = await settle(api.request, cid);
    expect(completed.latestTurn!.id).toBe(returnedTurnIds[0]);
    const replay = await hinted(api.request, cid, '中国', 'destination', clientMessageId, [200]);
    expect(replay.message).toEqual(first.message);
    expect(replay.message.payload).toEqual({ answeringSlot: 'applicantNationality' });
    const matches = (await rawMessages(api.request, cid)).items.filter(message => message.clientMessageId === clientMessageId);
    expect(matches).toEqual([first.message]);
    const state = await detail(api.request, cid);
    expect(state.conversation.profile.slots.applicantNationality.value).toBe('JP');
    expect(state.conversation.profile.slots.destination.status).toBe('missing');
});

test.describe('hinted task retry', () => {
    test.use({ appEnv: { DEMO_DELAY_MS: '1200' } });
    test(title('API-091'), async ({ api }) => {
        await login(api.request);
        const cid = await fresh(api.request);
        const sent = await hinted(api.request, cid, '日本', 'applicantNationality');
        await waitRunning(api.request, cid);
        const base = `/api/conversations/${cid}/turns/${sent.turn!.id}`;
        await parsed(await api.request.post(`${base}/cancel`), turnResponseSchema);
        expect((await detail(api.request, cid)).conversation.profile.slots.applicantNationality.status).toBe('missing');
        const retried = await parsed(await api.request.post(`${base}/retry`), turnResponseSchema, 202);
        expect(retried.turn.retryOfTurnId).toBe(sent.turn!.id);
        const state = await settle(api.request, cid);
        expect(state.conversation.profile.slots.applicantNationality).toMatchObject({ value: 'JP', sourceMessageId: sent.message.id });
        const history = (await rawMessages(api.request, cid)).items;
        expect(history.filter(message => message.clientMessageId === sent.message.clientMessageId)).toEqual([sent.message]);
        expect(history.filter(message => message.turnId === retried.turn.id && message.role === 'assistant')).toHaveLength(1);
        expect(history.filter(message => message.turnId === sent.turn!.id && message.role === 'assistant')).toHaveLength(0);
    });
});

const empty = { intent: 'provide_info', updates: [], unsure: [] };
async function useLocal(request: APIRequestContext, cid: string) {
    await expect.poll(async () => enginesResponseSchema.parse(await (await request.get('/api/engines')).json()).engines.find(engine => engine.id === 'local')?.available).toBe(true);
    await raw(await request.patch(`/api/conversations/${cid}`, { data: { enginePreference: 'local' } }));
}
async function occupyExecutor(request: APIRequestContext, app: AppInstance) {
    app.fakeRemote.setBehavior({ kind: 'hang' });
    const before = modelCalls(app.fakeRemote).length;
    const blocking = await create(request, '本轮等待受控模型', 'remote');
    await expect.poll(() => modelCalls(app.fakeRemote).length).toBe(before + 1);
    expect((await detail(request, blocking.conversation.id)).activeTurn?.status).toBe('running');
    return async () => {
        const stopped = await parsed(await request.post(`/api/conversations/${blocking.conversation.id}/turns/${blocking.turn.id}/cancel`), turnResponseSchema);
        expect(stopped.turn.status).toBe('cancelled');
    };
}

test.describe('local model answer context', () => {
    test.use({ appEnv: { LOCAL_LLM_MODEL: 'qa-model', LLM_API_KEY: 'qa-fake-key', TURN_CONCURRENCY: '1', LLM_TIMEOUT_MS: '10000', LOCAL_LLM_TIMEOUT_MS: '2000', TURN_TIMEOUT_MS: '20000' } });
    test(title('API-092'), async ({ api, app }) => {
        await login(api.request);
        const cid = await fresh(api.request);
        await useLocal(api.request, cid);
        app.fakeLocal.setBehavior({ kind: 'json', value: empty });
        const before = await detail(api.request, cid);
        await hinted(api.request, cid, '日本', 'applicantNationality');
        const state = await settle(api.request, cid);
        expect(state.latestTurn).toMatchObject({ engineUsed: 'local', promptVersion: 'v3', fallbacks: [] });
        expect(modelCalls(app.fakeLocal)).toHaveLength(1);
        const context = promptContext(modelCalls(app.fakeLocal)[0]!.body);
        expectPendingQuestions(context, ['applicantNationality']);
        expect(context.newMessages.map(message => message.content)).toEqual(['日本']);
        expect(state.conversation.profile.slots).toEqual(before.conversation.profile.slots);
        await hinted(api.request, cid, '智利', 'applicantNationality');
        const next = await settle(api.request, cid);
        expect(modelCalls(app.fakeLocal)).toHaveLength(2);
        const changedText = promptContext(modelCalls(app.fakeLocal)[1]!.body);
        expect(changedText.newMessages.map(message => message.content)).toEqual(['智利']);
        expect(changedText.pendingQuestions).toEqual(context.pendingQuestions);
        expect(next.conversation.profile.slots).toEqual(before.conversation.profile.slots);
    });

    test(title('API-093'), async ({ api, app }) => {
        await login(api.request);
        const cid = await fresh(api.request);
        await useLocal(api.request, cid);
        const before = await detail(api.request, cid);
        const release = await occupyExecutor(api.request, app);
        // Empty extraction keeps normal pending context stable across all three segments.
        app.fakeLocal.setBehavior({ kind: 'json', value: empty });
        await send(api.request, cid, '我想去葡萄牙');
        await hinted(api.request, cid, '日本', 'applicantNationality');
        await send(api.request, cid, '计划半年后出发');
        await send(api.request, cid, '补充说明');
        expect((await detail(api.request, cid)).activeTurn?.status).toBe('queued');
        expect(modelCalls(app.fakeLocal)).toHaveLength(0);
        await release();
        const state = await settle(api.request, cid);
        const contexts = modelCalls(app.fakeLocal).map(call => promptContext(call.body));
        expect(contexts.map(context => context.newMessages.map(message => message.content))).toEqual([
            ['我想去葡萄牙'], ['日本'], ['计划半年后出发', '补充说明'],
        ]);
        expectPendingQuestions(contexts[0]!, ['destination', 'applicantNationality']);
        expectPendingQuestions(contexts[1]!, ['applicantNationality']);
        expectPendingQuestions(contexts[2]!, ['destination', 'applicantNationality']);
        expect(state.conversation.profile.slots).toEqual(before.conversation.profile.slots);
    });

    test(title('API-094'), async ({ api, app }) => {
        await login(api.request);
        const cid = await fresh(api.request);
        await useLocal(api.request, cid);
        const release = await occupyExecutor(api.request, app);
        app.fakeLocal.enqueue(
            { kind: 'json', value: { ...empty, updates: [{ slot: 'destination', value: 'PT' }] } },
            { kind: 'json', value: { ...empty, updates: [{ slot: 'applicantNationality', value: 'JP' }] } },
        );
        const destination = await hinted(api.request, cid, '葡萄牙', 'destination');
        const nationality = await hinted(api.request, cid, '日本', 'applicantNationality');
        const quick = await send(api.request, cid, '中国', [answer('incomeCountry', 'CN')]);
        expect((await detail(api.request, cid)).activeTurn?.status).toBe('queued');
        await release();
        const state = await settle(api.request, cid);
        const contexts = modelCalls(app.fakeLocal).map(call => promptContext(call.body));
        expect(contexts.map(context => context.newMessages.map(message => message.content))).toEqual([['葡萄牙'], ['日本']]);
        expectPendingQuestions(contexts[0]!, ['destination']);
        expectPendingQuestions(contexts[1]!, ['applicantNationality']);
        expect(JSON.stringify(contexts[1]!.profile)).toContain('PT');
        expect(state.conversation.profile.slots.destination).toMatchObject({ value: 'PT', sourceMessageId: destination.message.id });
        expect(state.conversation.profile.slots.applicantNationality).toMatchObject({ value: 'JP', sourceMessageId: nationality.message.id });
        expect(state.conversation.profile.slots.incomeCountry).toMatchObject({ value: 'CN', sourceMessageId: quick.message.id });
        expect(state.latestTurn!.engineUsed).toBe('local');
    });

    test(title('API-095'), async ({ api, app }) => {
        await login(api.request);
        const cid = await fresh(api.request);
        await send(api.request, cid, '已有背景', [answer('applicantNationality', 'CN'), answer('hasPartner', true), answer('timeline', { unsure: true })]);
        const before = await settle(api.request, cid);
        await useLocal(api.request, cid);
        app.fakeLocal.setBehavior({ kind: 'json', value: empty });
        for (const answeringSlot of ['partnerNationality', 'timeline'] as const) {
            await hinted(api.request, cid, '请保留原有信息', answeringSlot);
            const state = await settle(api.request, cid);
            const context = promptContext(modelCalls(app.fakeLocal).at(-1)!.body);
            expectPendingQuestions(context, [answeringSlot]);
            expect(context.newMessages.map(message => message.content)).toEqual(['请保留原有信息']);
            expect(state.conversation.profile.slots).toEqual(before.conversation.profile.slots);
        }
        expect(modelCalls(app.fakeLocal)).toHaveLength(2);
    });
});
