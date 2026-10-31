import { test, expect } from '../../fixtures/test.js';
import { request as newRequest } from '@playwright/test';
import { conversationListResponseSchema, createConversationResponseSchema, postMessageResponseSchema, updateConversationResponseSchema, readResponseSchema, planResponseSchema, plansResponseSchema, meResponseSchema } from '../../../packages/shared/src/dto.js';
import { title, id, login, parsed, error, create, send, settle, detail, messages, seeded, plan, earlyAnswers } from './support.js';
test(title('API-001'), async ({ api }) => {
    const username = `QA-${id().slice(0, 15)}`;
    const first = await login(api.request, `  ${username}  `);
    const user = meResponseSchema.parse(await first.json()).user;
    const cookie = first.headers()['set-cookie'] ?? '';
    for (const expected of [/nc_token=/, /HttpOnly/i, /SameSite=Lax/i, /Path=\//, /Max-Age=315360000/])
        expect(cookie).toMatch(expected);
    const next = await login(api.request, username.toLowerCase());
    expect(meResponseSchema.parse(await next.json()).user.id).toBe(user.id);
    expect(next.headers()['set-cookie']).not.toBe(cookie);
    expect((await parsed(await api.request.get('/api/me'), meResponseSchema)).user.id).toBe(user.id);
    expect(cookie).not.toMatch(/;\s*Secure(?:;|$)/i);
    const forwarded = await api.request.post('/api/auth/login', {
        data: { username },
        headers: { 'X-Forwarded-Proto': 'https', Forwarded: 'proto=https' },
    });
    expect(forwarded.status()).toBe(200);
    expect(forwarded.headers()['set-cookie'] ?? '').toMatch(/nc_token=/);
    expect(forwarded.headers()['set-cookie'] ?? '').not.toMatch(/;\s*Secure(?:;|$)/i);
});
test(title('API-002'), async ({ api }) => {
    for (const username of ['', '  ', 'a', 'a'.repeat(33)])
        await error(await api.request.post('/api/auth/login', { data: { username } }), 422, 'VALIDATION_ERROR');
    for (const username of ['aa', 'a'.repeat(32)])
        expect((await login(api.request, username)).status()).toBe(200);
});
test(title('API-003'), async ({ api }) => {
    const routes = [['GET', '/me'], ['GET', '/engines'], ['GET', '/conversations'], ['POST', '/conversations'], ['GET', '/conversations/unknown'], ['PATCH', '/conversations/unknown'], ['GET', '/conversations/unknown/messages'], ['POST', '/conversations/unknown/messages'], ['POST', '/conversations/unknown/turns/unknown/cancel'], ['POST', '/conversations/unknown/turns/unknown/retry'], ['POST', '/conversations/unknown/read'], ['POST', '/conversations/unknown/plan'], ['GET', '/plans'], ['GET', '/plans/unknown'], ['POST', '/auth/logout']];
    for (const [method, path] of routes)
        await error(await api.request.fetch(`/api${path}`, { method, data: method === 'GET' ? undefined : {} }), 401, 'UNAUTHENTICATED');
});
test(title('API-004'), async ({ api, app }) => {
    await login(api.request);
    const saved = await api.request.storageState();
    const response = await api.request.post('/api/auth/logout');
    expect(response.status()).toBe(204);
    expect(response.headers()['set-cookie']).toMatch(/nc_token=;/);
    await error(await api.request.get('/api/me'), 401, 'UNAUTHENTICATED');
    const old = await newRequest.newContext({ baseURL: app.baseURL, storageState: saved });
    try {
        await error(await old.get('/api/me'), 401, 'UNAUTHENTICATED');
    }
    finally {
        await old.dispose();
    }
});
test.describe('token limit', () => {
    test.use({ appEnv: { TOKENS_PER_USER: '2' } });
    test(title('API-005'), async ({ app }) => {
        const contexts = await Promise.all([0, 1, 2].map(() => newRequest.newContext({ baseURL: app.baseURL })));
        try {
            for (const context of contexts)
                await login(context, 'qa-token-cap');
            await error(await contexts[0]!.get('/api/me'), 401, 'UNAUTHENTICATED');
            for (const context of contexts.slice(1))
                await parsed(await context.get('/api/me'), meResponseSchema);
        }
        finally {
            await Promise.all(contexts.map(context => context.dispose()));
        }
    });
});
test(title('API-006'), async ({ api }) => {
    expect((await api.request.get('/api/health')).status()).toBe(200);
    await login(api.request);
    await error(await api.request.get('/api/not-a-route'), 404, 'NOT_FOUND');
    await error(await api.request.post('/api/conversations', { headers: { 'Content-Type': 'application/json' }, data: '{"content":' }), 400, 'BAD_REQUEST');
});
test.describe('observable active tasks', () => {
    test.use({ appEnv: { DEMO_DELAY_MS: '800' } });
    test(title('API-007'), async ({ api }) => {
        await login(api.request);
        const a = await create(api.request);
        const b = await create(api.request, '我想去智利生活');
        expect(a.message.seq).toBe(1);
        expect(a.message.role).toBe('user');
        const list = await parsed(await api.request.get('/api/conversations?status=collecting'), conversationListResponseSchema);
        expect(list.items.map(item => item.id)).toEqual(expect.arrayContaining([a.conversation.id, b.conversation.id]));
        expect(list.items.map(item => item.updatedAt)).toEqual(list.items.map(item => item.updatedAt).sort().reverse());
        expect(list.activeTurns.map(turn => turn.conversationId)).toEqual(expect.arrayContaining([a.conversation.id, b.conversation.id]));
        expect(list.readStates.map(item => item.conversationId)).toEqual(expect.arrayContaining([a.conversation.id, b.conversation.id]));
        expect((await detail(api.request, a.conversation.id)).conversation.id).toBe(a.conversation.id);
    });
    test(title('API-008'), async ({ api }) => {
        await login(api.request);
        const clientMessageId = id();
        const data = { content: '我想去葡萄牙生活', clientMessageId, enginePreference: 'rules' };
        const responses = await Promise.all([api.request.post('/api/conversations', { data }), api.request.post('/api/conversations', { data })]);
        expect(responses.map(response => response.status()).sort()).toEqual([200, 201]);
        const bodies = await Promise.all(responses.map(async (response) => createConversationResponseSchema.parse(await response.json())));
        expect(bodies[0]!.conversation.id).toBe(bodies[1]!.conversation.id);
        expect(bodies[0]!.message.id).toBe(bodies[1]!.message.id);
        expect(bodies[0]!.turn.id).toBe(bodies[1]!.turn.id);
        await settle(api.request, bodies[0]!.conversation.id);
        const replay = await parsed(await api.request.post('/api/conversations', { data: { ...data, content: '不同文字' } }), createConversationResponseSchema, 200);
        expect(replay.conversation.id).toBe(bodies[0]!.conversation.id);
        expect((await parsed(await api.request.get('/api/conversations'), conversationListResponseSchema)).items).toHaveLength(1);
        expect((await messages(api.request, replay.conversation.id)).items).toHaveLength(2);
    });
    test(title('API-012'), async ({ api }) => {
        await login(api.request);
        const made = await create(api.request);
        await settle(api.request, made.conversation.id);
        const clientMessageId = id(), data = { content: '我是中国籍', clientMessageId };
        const responses = await Promise.all([api.request.post(`/api/conversations/${made.conversation.id}/messages`, { data }), api.request.post(`/api/conversations/${made.conversation.id}/messages`, { data })]);
        expect(responses.map(r => r.status()).sort()).toEqual([200, 202]);
        const results = await Promise.all(responses.map(async (r) => postMessageResponseSchema.parse(await r.json())));
        expect(results[0]!.message.id).toBe(results[1]!.message.id);
        expect(results[0]!.turn?.id).toBe(results[1]!.turn?.id);
        await settle(api.request, made.conversation.id);
        const all = (await messages(api.request, made.conversation.id)).items;
        expect(all).toHaveLength(4);
        expect(all.map(m => m.seq)).toEqual([1, 2, 3, 4]);
        expect(all.filter(m => m.clientMessageId === clientMessageId)).toHaveLength(1);
    });
});
test(title('API-009'), async ({ api, app }) => {
    const cid = await seeded(api.request);
    const before = await detail(api.request, cid);
    const history = await messages(api.request, cid);
    const made = await plan(api.request, cid);
    const other = await newRequest.newContext({ baseURL: app.baseURL });
    try {
        await login(other);
        const tid = before.latestTurn!.id;
        const routes: [
            string,
            string,
            unknown?
        ][] = [['GET', `/conversations/${cid}`], ['PATCH', `/conversations/${cid}`, { enginePreference: 'rules' }], ['GET', `/conversations/${cid}/messages`], ['POST', `/conversations/${cid}/messages`, { content: '重放', clientMessageId: history.items[0]!.clientMessageId }], ['POST', `/conversations/${cid}/turns/${tid}/cancel`], ['POST', `/conversations/${cid}/turns/${tid}/retry`], ['POST', `/conversations/${cid}/read`, { seq: 1 }], ['POST', `/conversations/${cid}/plan`, {}], ['GET', `/plans/${made.plan.id}`]];
        for (const [method, path, data] of routes)
            await error(await other.fetch(`/api${path}`, { method, data }), 404, 'NOT_FOUND');
        expect((await messages(api.request, cid)).items).toEqual(history.items);
        expect((await detail(api.request, cid)).conversation.profile).toEqual(before.conversation.profile);
    }
    finally {
        await other.dispose();
    }
});
test(title('API-010'), async ({ api }) => {
    await login(api.request);
    const a = await create(api.request), b = await create(api.request);
    await settle(api.request, b.conversation.id);
    for (const action of ['cancel', 'retry'])
        await error(await api.request.post(`/api/conversations/${a.conversation.id}/turns/${b.turn.id}/${action}`), 404, 'NOT_FOUND');
    expect((await detail(api.request, b.conversation.id)).latestTurn!.status).toBe('completed');
});
test(title('API-011'), async ({ api }) => {
    await login(api.request);
    const made = await create(api.request);
    await settle(api.request, made.conversation.id);
    const base = `/api/conversations/${made.conversation.id}`;
    for (const data of [{ content: ' ', clientMessageId: id() }, { content: 'x', clientMessageId: id(), payload: { answers: [{ slot: 'childrenCount', value: 11, label: '11' }] } }, { content: 'x', clientMessageId: '' }])
        await error(await api.request.post(`${base}/messages`, { data }), 422, 'VALIDATION_ERROR');
    for (const query of ['?limit=101', '?limit=0', '?before=-1', '?limit=oops'])
        await error(await api.request.get(`${base}/messages${query}`), 422, 'VALIDATION_ERROR');
    await error(await api.request.patch(base, { data: { enginePreference: 'unknown' } }), 422, 'VALIDATION_ERROR');
    await error(await api.request.post(`${base}/read`, { data: { seq: -1 } }), 422, 'VALIDATION_ERROR');
    await error(await api.request.post(`${base}/plan`, { data: { allowIncomplete: 'yes' } }), 422, 'VALIDATION_ERROR');
    expect((await messages(api.request, made.conversation.id)).items).toHaveLength(2);
});
test(title('API-013'), async ({ api }) => {
    test.setTimeout(120000);
    await login(api.request);
    const made = await create(api.request);
    const cid = made.conversation.id;
    await settle(api.request, cid);
    for (let i = 0; i < 37; i++) {
        await send(api.request, cid, '时间没想好');
        await settle(api.request, cid);
    }
    const first = await messages(api.request, cid, '?limit=30');
    expect(first.items).toHaveLength(30);
    expect(first.nextCursor).not.toBeNull();
    const boundary = first.items.at(-1)!.seq;
    await send(api.request, cid, '我是中国籍');
    await settle(api.request, cid);
    const all = [...first.items];
    let cursor = first.nextCursor;
    while (cursor !== null) {
        const page = await messages(api.request, cid, `?limit=30&before=${cursor}`);
        expect(page.items.every(m => m.seq < cursor!)).toBe(true);
        expect(page.items.map(m => m.seq)).toEqual(page.items.map(m => m.seq).sort((a, b) => a - b));
        all.push(...page.items);
        cursor = page.nextCursor;
    }
    expect(new Set(all.map(m => m.id)).size).toBe(boundary);
    expect(all.map(m => m.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: boundary }, (_, i) => i + 1));
});
test(title('API-014'), async ({ api }) => {
    const cid = await seeded(api.request);
    const current = await detail(api.request, cid);
    const mark = async (seq: number) => parsed(await api.request.post(`/api/conversations/${cid}/read`, { data: { seq } }), readResponseSchema);
    expect((await mark(2)).lastReadSeq).toBe(2);
    expect((await mark(1)).lastReadSeq).toBe(2);
    const overflow = await api.request.post(`/api/conversations/${cid}/read`, { data: { seq: current.conversation.lastSeq + 1 } });
    expect((await parsed(overflow, readResponseSchema, 200)).lastReadSeq).toBe(current.conversation.lastSeq);
    expect((await detail(api.request, cid)).readState.lastReadSeq).toBe(current.conversation.lastSeq);
    expect((await parsed(await api.request.get('/api/conversations'), conversationListResponseSchema)).readStates.find(s => s.conversationId === cid)!.lastReadSeq).toBe(current.conversation.lastSeq);
    expect((await mark(1)).lastReadSeq).toBe(current.conversation.lastSeq);
});
test(title('API-015'), async ({ api }) => {
    await login(api.request);
    const a = await create(api.request), b = await create(api.request);
    await settle(api.request, a.conversation.id);
    const before = await detail(api.request, a.conversation.id);
    const patched = await parsed(await api.request.patch(`/api/conversations/${a.conversation.id}`, { data: { enginePreference: 'auto' } }), updateConversationResponseSchema);
    expect(patched.conversation.enginePreference).toBe('auto');
    expect(patched.conversation.version).toBeGreaterThan(before.conversation.version);
    await send(api.request, a.conversation.id, '我是中国籍');
    expect((await settle(api.request, a.conversation.id)).latestTurn!.engineRequested).toBe('auto');
    expect((await detail(api.request, b.conversation.id)).conversation.enginePreference).toBe('rules');
});
test(title('API-016'), async ({ api }) => {
    await login(api.request);
    const made = await create(api.request);
    await settle(api.request, made.conversation.id);
    const failure = await error(await api.request.post(`/api/conversations/${made.conversation.id}/plan`, { data: { allowIncomplete: true } }), 422, 'PROFILE_INSUFFICIENT');
    expect(failure.details?.missing).toContain('applicantNationality');
    expect((await detail(api.request, made.conversation.id)).plan).toBeNull();
});
test(title('API-017'), async ({ api }) => {
    const cid = await seeded(api.request, earlyAnswers);
    const failure = await error(await api.request.post(`/api/conversations/${cid}/plan`, { data: {} }), 409, 'PROFILE_INCOMPLETE');
    expect(failure.details?.missing).toEqual(expect.arrayContaining(['hasPartner', 'childrenCount']));
    const made = await plan(api.request, cid, true);
    expect(made.plan.content.generatedEarly).toBe(true);
    expect(made.plan.content.profileSummary.unknown.length).toBeGreaterThan(0);
    const replay = await parsed(await api.request.post(`/api/conversations/${cid}/plan`, { data: {} }), planResponseSchema, 200);
    expect(replay.plan).toEqual(made.plan);
});
test(title('API-018'), async ({ api }) => {
    const cid = await seeded(api.request);
    expect((await detail(api.request, cid)).conversation.progress.isComplete).toBe(true);
    const content = (await plan(api.request, cid)).plan.content;
    expect(content.generatedEarly).toBe(false);
    expect(content.coverage).toBe('full');
    expect(content.destination).toBe('PT');
    expect(content.phases.map(p => p.phase)).toEqual(['before', 'arrival', 'ongoing']);
    const steps = content.phases.flatMap(p => p.steps);
    expect(steps.length).toBeGreaterThan(8);
    expect(new Set(steps.map(s => s.id)).size).toBe(steps.length);
    const first = steps.find(s => s.id === content.firstStepId);
    expect(first).toBeDefined();
    expect(first!.dependsOn).toHaveLength(0);
    expect(content.phases[0]!.steps).toContainEqual(first);
    for (const [index, step] of steps.entries()) {
        expect(step.title).not.toBe('');
        expect(step.why).not.toBe('');
        for (const material of step.materials)
            expect(material.trim()).not.toBe('');
        for (const dependency of step.dependsOn)
            expect(steps.slice(0, index).map(s => s.id)).toContain(dependency);
        if (step.needsProfessional)
            expect(step.professionalNote).toBeTruthy();
    }
    expect(content.professionalBoundary.length).toBeGreaterThanOrEqual(3);
    expect(content.disclaimer).toMatch(/不能替代.*持牌/);
    expect(content.disclaimer).toMatch(/示例|演示用途/);
    expect(content.sources.length).toBeGreaterThan(0);
    for (const source of content.sources)
        expect(source.note).toMatch(/未做时效核实/);
    expect(content.profileSummary.known.map(s => s.slot)).toContain('partnerNationality');
});
test(title('API-019'), async ({ api, app }) => {
    const cid = await seeded(api.request);
    const made = await plan(api.request, cid);
    const before = await detail(api.request, cid), history = await messages(api.request, cid);
    await app.restart();
    expect((await detail(api.request, cid))).toEqual(before);
    expect((await messages(api.request, cid))).toEqual(history);
    expect((await parsed(await api.request.get(`/api/plans/${made.plan.id}`), planResponseSchema)).plan).toEqual(made.plan);
});
test(title('API-020'), async ({ api }) => {
    const pt = await seeded(api.request, earlyAnswers);
    const ptPlan = await plan(api.request, pt, true);
    const cl = await create(api.request, '我想搬到智利生活');
    await settle(api.request, cl.conversation.id);
    await send(api.request, cl.conversation.id, '我是中国籍');
    await settle(api.request, cl.conversation.id);
    const result = await plan(api.request, cl.conversation.id, true);
    expect(result.plan.destination).toBe('CL');
    expect(result.plan.coverage).toBe('generic');
    expect(result.plan.content.phases.flatMap(p => p.steps).length).toBeGreaterThan(0);
    expect(result.plan.content).not.toEqual(ptPlan.plan.content);
    expect(result.plan.content.disclaimer).toMatch(/持牌/);
});
test(title('API-021'), async ({ api, app }) => {
    const cid = await seeded(api.request);
    const made = await plan(api.request, cid);
    const list = await parsed(await api.request.get('/api/plans'), plansResponseSchema);
    expect(list.items.map(p => p.id)).toEqual([made.plan.id]);
    expect((await parsed(await api.request.get(`/api/plans/${made.plan.id}`), planResponseSchema)).plan).toEqual(made.plan);
    const other = await newRequest.newContext({ baseURL: app.baseURL });
    try {
        await login(other);
        expect((await parsed(await other.get('/api/plans'), plansResponseSchema)).items).toHaveLength(0);
        await error(await other.get(`/api/plans/${made.plan.id}`), 404, 'NOT_FOUND');
    }
    finally {
        await other.dispose();
    }
});
test(title('API-022'), async ({ api }) => {
    const cid = await seeded(api.request);
    const before = await detail(api.request, cid);
    const original = (await messages(api.request, cid)).items[0]!;
    await plan(api.request, cid);
    await error(await api.request.post(`/api/conversations/${cid}/messages`, { data: { content: '新消息', clientMessageId: id() } }), 409, 'CONVERSATION_COMPLETED');
    await error(await api.request.patch(`/api/conversations/${cid}`, { data: { enginePreference: 'auto' } }), 409, 'CONVERSATION_COMPLETED');
    const replay = await parsed(await api.request.post(`/api/conversations/${cid}/messages`, { data: { content: '重放', clientMessageId: original.clientMessageId } }), postMessageResponseSchema, 200);
    expect(replay.message.id).toBe(original.id);
    expect((await api.request.post(`/api/conversations/${cid}/turns/${before.latestTurn!.id}/cancel`)).status()).toBe(200);
    await error(await api.request.post(`/api/conversations/${cid}/turns/${before.latestTurn!.id}/retry`), 409, 'TURN_NOT_RETRYABLE');
});
test.describe('character cap', () => {
    test.use({ appEnv: { LIMIT_MESSAGE_CHARS: '20' } });
    test(title('API-023'), async ({ api }) => {
        await login(api.request);
        const made = await create(api.request, `  ${'a'.repeat(20)}  `);
        await settle(api.request, made.conversation.id);
        await error(await api.request.post('/api/conversations', { data: { content: 'a'.repeat(21), clientMessageId: id() } }), 422, 'MESSAGE_TOO_LONG');
        await error(await api.request.post(`/api/conversations/${made.conversation.id}/messages`, { data: { content: 'a'.repeat(21), clientMessageId: id() } }), 422, 'MESSAGE_TOO_LONG');
        await error(await api.request.post(`/api/conversations/${made.conversation.id}/messages`, { data: { content: ' ', clientMessageId: id() } }), 422, 'VALIDATION_ERROR');
    });
});
test.describe('conversation cap', () => {
    test.use({ appEnv: { LIMIT_CONVERSATIONS_PER_USER: '2' } });
    test(title('API-024'), async ({ api }) => {
        const cid = await seeded(api.request, earlyAnswers);
        await plan(api.request, cid, true);
        const made = await create(api.request);
        await settle(api.request, made.conversation.id);
        await error(await api.request.post('/api/conversations', { data: { content: '新咨询', clientMessageId: id() } }), 422, 'CONVERSATION_LIMIT_REACHED');
        const replay = await parsed(await api.request.post('/api/conversations', { data: { content: '重放', clientMessageId: made.message.clientMessageId } }), createConversationResponseSchema, 200);
        expect(replay.conversation.id).toBe(made.conversation.id);
    });
});
test.describe('message cap', () => {
    test.use({ appEnv: { LIMIT_MESSAGES_PER_CONVERSATION: '4' } });
    test(title('API-025'), async ({ api }) => {
        await login(api.request);
        const made = await create(api.request);
        await settle(api.request, made.conversation.id);
        const sent = await send(api.request, made.conversation.id, '我是中国籍');
        await settle(api.request, made.conversation.id);
        const all = await messages(api.request, made.conversation.id);
        expect(all.items.map(m => m.seq)).toEqual([1, 2, 3, 4]);
        expect(all.items[3]!.role).toBe('assistant');
        await error(await api.request.post(`/api/conversations/${made.conversation.id}/messages`, { data: { content: '继续', clientMessageId: id() } }), 422, 'CONVERSATION_FULL');
        expect((await parsed(await api.request.post(`/api/conversations/${made.conversation.id}/messages`, { data: { content: '重放', clientMessageId: sent.message.clientMessageId } }), postMessageResponseSchema, 200)).message.id).toBe(sent.message.id);
    });
});

test(title('API-081'), async ({ api }) => {
    await login(api.request);
    const before = await parsed(await api.request.get('/api/conversations'), conversationListResponseSchema);
    const response = await api.request.post('/api/conversations', { data: { content: '我想搬到葡萄牙生活', clientMessageId: id(), padding: 'x'.repeat(65 * 1024) } });
    await test.info().attach('oversized-request-response', { body: JSON.stringify({ status: response.status(), body: await response.text() }), contentType: 'application/json' });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
    expect((await parsed(await api.request.get('/api/conversations'), conversationListResponseSchema)).items).toEqual(before.items);
});
test(title('API-082'), async ({ api }) => {
    const tax = await seeded(api.request);
    await send(api.request, tax, '只想了解税务');
    await settle(api.request, tax);
    const taxSteps = (await plan(api.request, tax)).plan.content.phases.flatMap(phase => phase.steps);
    const other = await seeded(api.request);
    await send(api.request, other, '只想了解居留和开公司');
    await settle(api.request, other);
    const otherSteps = (await plan(api.request, other)).plan.content.phases.flatMap(phase => phase.steps);
    expect(taxSteps.some(step => step.goal === 'tax')).toBe(true);
    expect(taxSteps.every(step => ['general', 'tax'].includes(step.goal))).toBe(true);
    expect(otherSteps.some(step => step.goal === 'residence')).toBe(true);
    expect(otherSteps.some(step => step.goal === 'company')).toBe(true);
    expect(otherSteps.every(step => ['general', 'residence', 'company'].includes(step.goal))).toBe(true);
    expect(otherSteps.map(step => step.id)).not.toEqual(taxSteps.map(step => step.id));
});
