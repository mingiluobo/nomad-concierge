import { test, expect } from '../../fixtures/test.js';
import { turnResponseSchema, postMessageResponseSchema, planResponseSchema, plansResponseSchema } from '../../../packages/shared/src/dto.js';
import { SocketProbe, cookieHeader } from '../../harness/socket.js';
import { title, id, login, parsed, error, create, send, settle, detail, messages, seeded, plan, earlyAnswers, answer, waitRunning } from './support.js';
test.describe('observable delayed tasks', () => {
    test.use({ appEnv: { DEMO_DELAY_MS: '1200' } });
    test(title('API-066'), async ({ api }) => {
        await login(api.request);
        const made = await create(api.request);
        await waitRunning(api.request, made.conversation.id);
        const url = `/api/conversations/${made.conversation.id}/turns/${made.turn.id}`;
        const cancelled = await parsed(await api.request.post(`${url}/cancel`), turnResponseSchema);
        expect(cancelled.turn.status).toBe('cancelled');
        expect((await parsed(await api.request.post(`${url}/cancel`), turnResponseSchema)).turn).toEqual(cancelled.turn);
        const retry = await parsed(await api.request.post(`${url}/retry`), turnResponseSchema, 202);
        expect(retry.turn.id).not.toBe(made.turn.id);
        expect(retry.turn.retryOfTurnId).toBe(made.turn.id);
        await settle(api.request, made.conversation.id);
        const history = await messages(api.request, made.conversation.id);
        expect(history.items.filter(m => m.role === 'assistant')).toHaveLength(1);
        expect(history.items.find(m => m.role === 'assistant')?.turnId).toBe(retry.turn.id);
    });
    test(title('API-067'), async ({ api }) => {
        await login(api.request);
        const made = await create(api.request);
        await waitRunning(api.request, made.conversation.id);
        const extra = await send(api.request, made.conversation.id, '我是中国籍');
        expect(extra.turn?.id).not.toBe(made.turn.id);
        const old = await parsed(await api.request.post(`/api/conversations/${made.conversation.id}/turns/${made.turn.id}/cancel`), turnResponseSchema);
        expect(old.turn.status).toBe('superseded');
        const state = await settle(api.request, made.conversation.id);
        expect(state.conversation.profile.slots).toMatchObject({ destination: { value: 'PT' }, applicantNationality: { value: 'CN' } });
        const all = (await messages(api.request, made.conversation.id)).items;
        expect(all.filter(m => m.role === 'assistant')).toHaveLength(1);
        expect(all.filter(m => m.role === 'assistant' && m.turnId === made.turn.id)).toHaveLength(0);
        expect(all.map(m => m.seq)).toEqual([1, 2, 3]);
    });
    test(title('API-068'), async ({ api }) => {
        const cid = await seeded(api.request, earlyAnswers);
        const correction = await send(api.request, cid, '不对，我是葡萄牙籍');
        await waitRunning(api.request, cid);
        await parsed(await api.request.post(`/api/conversations/${cid}/turns/${correction.turn!.id}/cancel`), turnResponseSchema);
        const result = await error(await api.request.post(`/api/conversations/${cid}/plan`, { data: { allowIncomplete: true } }), 409, 'UNPROCESSED_MESSAGES');
        expect(result.details?.count).toBe(1);
        expect((await detail(api.request, cid)).conversation.status).toBe('collecting');
        await parsed(await api.request.post(`/api/conversations/${cid}/turns/${correction.turn!.id}/retry`), turnResponseSchema, 202);
        await settle(api.request, cid);
        const content = (await plan(api.request, cid, true)).plan.content;
        expect(content.profileSummary.known).toContainEqual(expect.objectContaining({ slot: 'applicantNationality', display: expect.stringContaining('葡萄牙') }));
    });
    test(title('API-069'), async ({ api }) => {
        const cid = await seeded(api.request, earlyAnswers);
        await send(api.request, cid, '我一个人');
        await waitRunning(api.request, cid);
        await error(await api.request.post(`/api/conversations/${cid}/plan`, { data: { allowIncomplete: true } }), 409, 'TURN_IN_PROGRESS');
        expect((await detail(api.request, cid)).conversation.status).toBe('collecting');
    });
    test(title('API-070'), async ({ api }) => {
        await login(api.request);
        const made = await create(api.request);
        await waitRunning(api.request, made.conversation.id);
        const base = `/api/conversations/${made.conversation.id}/turns/${made.turn.id}`;
        await parsed(await api.request.post(`${base}/cancel`), turnResponseSchema);
        const retry = await parsed(await api.request.post(`${base}/retry`), turnResponseSchema, 202);
        const duplicate = await parsed(await api.request.post(`${base}/retry`), turnResponseSchema, 200);
        expect(duplicate.turn.id).toBe(retry.turn.id);
        await settle(api.request, made.conversation.id);
        await error(await api.request.post(`${base}/retry`), 409, 'TURN_NOT_RETRYABLE');
    });
    test(title('API-071'), async ({ api }) => {
        const cid = await seeded(api.request, earlyAnswers);
        const messageId = id();
        const [generated, sent] = await Promise.all([api.request.post(`/api/conversations/${cid}/plan`, { data: { allowIncomplete: true } }), api.request.post(`/api/conversations/${cid}/messages`, { data: { content: '不对，我是葡萄牙籍', clientMessageId: messageId } })]);
        expect([generated.status(), sent.status()]).toEqual(expect.arrayContaining([409]));
        expect([generated.status(), sent.status()].filter(s => s === 201 || s === 202)).toHaveLength(1);
        if (generated.status() === 201) {
            await parsed(generated, planResponseSchema, 201);
            await error(sent, 409, 'CONVERSATION_COMPLETED');
            expect((await messages(api.request, cid)).items.some(m => m.clientMessageId === messageId)).toBe(false);
        }
        else {
            await parsed(sent, postMessageResponseSchema, 202);
            await error(generated, 409, 'TURN_IN_PROGRESS');
            expect((await settle(api.request, cid)).conversation.status).toBe('collecting');
        }
    });
    test(title('API-072'), async ({ api }) => {
        const cid = await seeded(api.request);
        await send(api.request, cid, '配偶是中国籍');
        await waitRunning(api.request, cid);
        const quick = await send(api.request, cid, '同本人国籍', [answer('partnerNationality', 'PT')]);
        await send(api.request, cid, '计划时间是明年');
        let state = await settle(api.request, cid);
        expect(state.conversation.profile.slots.partnerNationality).toMatchObject({ value: 'PT', sourceMessageId: quick.message.id });
        expect(state.conversation.profile.slots.timeline.value).toBe('6to12m');
        const before = (await messages(api.request, cid)).items.filter(m => m.role === 'assistant').length;
        await send(api.request, cid, '同本人国籍', [answer('partnerNationality', 'PT')]);
        await waitRunning(api.request, cid);
        const text = await send(api.request, cid, '配偶是中国籍');
        const lastText = await send(api.request, cid, '计划时间是明年');
        state = await settle(api.request, cid);
        expect(state.conversation.profile.slots.partnerNationality.value).toBe('CN');
        expect(state.conversation.profile.slots.partnerNationality.sourceMessageId).toBe(lastText.message.id);
        expect(text.message.seq).toBeGreaterThan(quick.message.seq);
        expect((await messages(api.request, cid)).items.filter(m => m.role === 'assistant')).toHaveLength(before + 1);
    });
    test(title('API-073'), async ({ api, app }) => {
        await login(api.request);
        const made = await create(api.request);
        const before = await waitRunning(api.request, made.conversation.id);
        const oldPid = app.pid;
        expect(oldPid).toBeGreaterThan(0);
        await app.stop('SIGKILL');
        await app.start();
        expect(app.pid).not.toBe(oldPid);
        const state = await settle(api.request, made.conversation.id);
        expect(state.latestTurn!.id).toBe(made.turn.id);
        expect(state.latestTurn!.attempt).toBe(before.activeTurn!.attempt + 1);
        const all = (await messages(api.request, made.conversation.id)).items;
        expect(all.filter(m => m.role === 'assistant')).toHaveLength(1);
        expect(all.find(m => m.role === 'assistant')?.turnId).toBe(made.turn.id);
    });
    test(title('API-074'), async ({ api, app }) => {
        await login(api.request);
        const socket = await SocketProbe.connect(app.baseURL, { cookie: await cookieHeader(api.request) });
        try {
            socket.resume(null);
            await socket.waitReady();
            const made = await create(api.request);
            const before = await waitRunning(api.request, made.conversation.id);
            const after = socket.messages.length;
            await app.stop('SIGTERM');
            const queued = await socket.waitFor(event => event.type === 'event' && event.eventType === 'turn.upserted' && event.payload.turn.id === made.turn.id && event.payload.turn.status === 'queued', { after });
            expect(queued.type).toBe('event');
            expect((await socket.waitClose()).code).toBe(1012);
            await test.info().attach('graceful-shutdown-events', { body: JSON.stringify(socket.messages, null, 2), contentType: 'application/json' });
            await app.start();
            const state = await settle(api.request, made.conversation.id);
            expect(state.latestTurn!.id).toBe(made.turn.id);
            expect(state.latestTurn!.attempt).toBe(before.activeTurn!.attempt + 1);
            expect((await messages(api.request, made.conversation.id)).items.filter(m => m.role === 'assistant')).toHaveLength(1);
        }
        finally {
            await socket.close();
        }
    });
    test(title('API-078'), async ({ api }) => {
        await login(api.request);
        const [a, b] = await Promise.all([create(api.request, '我是中国籍，想搬到葡萄牙生活'), create(api.request, '我是日本籍，想搬到智利生活')]);
        await waitRunning(api.request, a.conversation.id);
        const sent = await Promise.all([send(api.request, a.conversation.id, '现在住在中国'), send(api.request, a.conversation.id, '带两个孩子')]);
        expect(new Set(sent.map(m => m.message.seq)).size).toBe(2);
        const [left, right] = await Promise.all([settle(api.request, a.conversation.id), settle(api.request, b.conversation.id)]);
        expect(left.conversation.profile.slots).toMatchObject({ destination: { value: 'PT' }, applicantNationality: { value: 'CN' }, currentResidence: { value: 'CN' }, childrenCount: { value: 2 } });
        expect(right.conversation.profile.slots).toMatchObject({ destination: { value: 'CL' }, applicantNationality: { value: 'JP' }, currentResidence: { status: 'missing' }, childrenCount: { status: 'missing' } });
        const all = (await messages(api.request, a.conversation.id)).items;
        expect(all.map(m => m.seq)).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
        expect(all.filter(m => m.role === 'assistant')).toHaveLength(1);
    });
});
test.describe('recovery cap', () => {
    test.use({ appEnv: { DEMO_DELAY_MS: '10000' } });
    test(title('API-075'), async ({ api, app }) => {
        test.setTimeout(60000);
        await login(api.request);
        const made = await create(api.request);
        for (let attempt = 1; attempt <= 3; attempt++) {
            const current = await waitRunning(api.request, made.conversation.id);
            expect(current.activeTurn!.id).toBe(made.turn.id);
            expect(current.activeTurn!.attempt).toBe(attempt);
            await app.stop('SIGKILL');
            await app.start();
        }
        const state = await settle(api.request, made.conversation.id, 'failed');
        expect(state.latestTurn!.id).toBe(made.turn.id);
        expect(state.latestTurn!.errorCode).toBe('RECOVERY_LIMIT');
        expect((await messages(api.request, made.conversation.id)).items.filter(m => m.role === 'assistant')).toHaveLength(0);
    });
});
test.describe('whole turn deadline', () => {
    test.use({ appEnv: { DEMO_DELAY_MS: '10000', TURN_TIMEOUT_MS: '2100', LLM_TIMEOUT_MS: '20', LOCAL_LLM_TIMEOUT_MS: '20' } });
    test(title('API-076'), async ({ api }) => {
        await login(api.request);
        const made = await create(api.request);
        const state = await settle(api.request, made.conversation.id, 'failed');
        expect(state.latestTurn!.errorCode).toBe('TURN_TIMEOUT');
        const next = await parsed(await api.request.post(`/api/conversations/${made.conversation.id}/turns/${made.turn.id}/retry`), turnResponseSchema, 202);
        expect(next.turn.id).not.toBe(made.turn.id);
        expect(next.turn.retryOfTurnId).toBe(made.turn.id);
    });
});
test.describe('queued commands', () => {
    test.use({ appEnv: { DEMO_DELAY_MS: '2000', TURN_CONCURRENCY: '1' } });
    test(title('API-077'), async ({ api }) => {
        await login(api.request);
        const first = await create(api.request);
        await waitRunning(api.request, first.conversation.id);
        const second = await create(api.request);
        expect((await detail(api.request, second.conversation.id)).activeTurn!.status).toBe('queued');
        const base = `/api/conversations/${second.conversation.id}/turns/${second.turn.id}`;
        expect((await parsed(await api.request.post(`${base}/cancel`), turnResponseSchema)).turn.status).toBe('cancelled');
        const retried = await parsed(await api.request.post(`${base}/retry`), turnResponseSchema, 202);
        expect(retried.turn.retryOfTurnId).toBe(second.turn.id);
        const final = await settle(api.request, second.conversation.id);
        expect(final.latestTurn!.id).toBe(retried.turn.id);
        expect((await messages(api.request, second.conversation.id)).items.filter(m => m.role === 'assistant')).toHaveLength(1);
    });
});
test(title('API-079'), async ({ api }) => {
    const cid = await seeded(api.request, earlyAnswers);
    const responses = await Promise.all([api.request.post(`/api/conversations/${cid}/plan`, { data: { allowIncomplete: true } }), api.request.post(`/api/conversations/${cid}/plan`, { data: { allowIncomplete: true } })]);
    expect(responses.map(r => r.status()).sort()).toEqual([200, 201]);
    const results = await Promise.all(responses.map(async (r) => planResponseSchema.parse(await r.json())));
    expect(results[0]!.plan.id).toBe(results[1]!.plan.id);
    expect((await parsed(await api.request.get('/api/plans'), plansResponseSchema)).items).toHaveLength(1);
    expect((await detail(api.request, cid)).conversation.planId).toBe(results[0]!.plan.id);
});
test.describe('supplement capacity', () => {
    test.use({ appEnv: { DEMO_DELAY_MS: '2000', LIMIT_MESSAGES_PER_CONVERSATION: '4' } });
    test(title('API-080'), async ({ api }) => {
        await login(api.request);
        const made = await create(api.request);
        await waitRunning(api.request, made.conversation.id);
        await send(api.request, made.conversation.id, '我是中国籍');
        const last = await send(api.request, made.conversation.id, '一个人去');
        await error(await api.request.post(`/api/conversations/${made.conversation.id}/messages`, { data: { content: '再补充', clientMessageId: id() } }), 422, 'CONVERSATION_FULL');
        const base = `/api/conversations/${made.conversation.id}/turns/${last.turn!.id}`;
        await parsed(await api.request.post(`${base}/cancel`), turnResponseSchema);
        await parsed(await api.request.post(`${base}/retry`), turnResponseSchema, 202);
        await settle(api.request, made.conversation.id);
        const all = (await messages(api.request, made.conversation.id)).items;
        expect(all).toHaveLength(4);
        expect(all.filter(m => m.role === 'user')).toHaveLength(3);
        expect(all.filter(m => m.role === 'assistant')).toHaveLength(1);
    });
});
