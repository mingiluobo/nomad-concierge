import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { createConversationResponseSchema, postMessageResponseSchema, conversationResponseSchema, messagesResponseSchema, assistantPayloadSchema, planResponseSchema, type StructuredAnswer } from '../../../packages/shared/src/dto.js';
import { errorResponseSchema } from '../../../packages/shared/src/errors.js';
import type { SlotKey } from '../../../packages/shared/src/profile.js';
import { apiCases } from '../../catalog/api.js';
export const title = (id: string): string => {
    const row = apiCases.find(item => item.id === id);
    if (!row)
        throw new Error(`Missing case ${id}`);
    return `${id} ${row.title}`;
};
export const id = (): string => randomUUID();
export const answer = (slot: SlotKey, value: unknown, label = String(value)): StructuredAnswer => ({ slot, value, label });
export async function parsed<T>(response: APIResponse, schema: z.ZodType<T>, status = 200): Promise<T> {
    const body: unknown = await response.json();
    await test.info().attach(`HTTP ${response.status()} ${new URL(response.url()).pathname}`, { body: JSON.stringify(body, null, 2), contentType: 'application/json' });
    expect(response.status()).toBe(status);
    return schema.parse(body);
}
export async function error(response: APIResponse, status: number, code: string) {
    const body = await parsed(response, errorResponseSchema, status);
    expect(body.error.code).toBe(code);
    expect(body.error.message).not.toBe('');
    expect(body.error.requestId).not.toBe('');
    expect(body).not.toHaveProperty('stack');
    return body.error;
}
export async function login(request: APIRequestContext, username = `qa-${id().slice(0, 20)}`) {
    const response = await request.post('/api/auth/login', { data: { username } });
    expect(response.status()).toBe(200);
    return response;
}
export async function create(request: APIRequestContext, content = '我想搬到葡萄牙生活', enginePreference = 'rules', clientMessageId = id()) {
    return parsed(await request.post('/api/conversations', { data: { content, enginePreference, clientMessageId } }), createConversationResponseSchema, 201);
}
export async function send(request: APIRequestContext, conversationId: string, content: string, answers?: StructuredAnswer[], clientMessageId = id()) {
    return parsed(await request.post(`/api/conversations/${conversationId}/messages`, { data: { content, clientMessageId, ...(answers ? { payload: { answers } } : {}) } }), postMessageResponseSchema, 202);
}
export async function detail(request: APIRequestContext, conversationId: string) {
    return parsed(await request.get(`/api/conversations/${conversationId}`), conversationResponseSchema);
}
export async function settle(request: APIRequestContext, conversationId: string, status = 'completed') {
    await expect.poll(async () => {
        const result = conversationResponseSchema.parse(await (await request.get(`/api/conversations/${conversationId}`)).json());
        return result.activeTurn ? 'active' : result.latestTurn?.status;
    }, { timeout: 30000, intervals: [20, 50, 100, 200] }).toBe(status);
    return detail(request, conversationId);
}
export async function messages(request: APIRequestContext, conversationId: string, query = '') {
    return parsed(await request.get(`/api/conversations/${conversationId}/messages${query}`), messagesResponseSchema);
}
export async function reply(request: APIRequestContext, conversationId: string) {
    const result = await messages(request, conversationId);
    const message = result.items.filter(item => item.role === 'assistant').at(-1);
    expect(message).toBeDefined();
    return { message: message!, payload: assistantPayloadSchema.parse(message!.payload) };
}
export const fullAnswers: StructuredAnswer[] = [
    answer('destination', 'PT'), answer('goals', ['residence', 'company', 'tax', 'education', 'healthcare']),
    answer('applicantNationality', 'CN'), answer('hasPartner', true), answer('partnerNationality', 'PT'),
    answer('childrenCount', 2), answer('childrenAges', [6, 9]), answer('currentResidence', 'CN'),
    answer('residenceStatus', 'citizen'), answer('timeline', '6to12m'), answer('incomeSource', 'freelancer'),
    answer('businessType', 'software'), answer('incomeCountry', 'CN'), answer('schoolPreference', 'public'), answer('hasHealthInsurance', false),
];
export const earlyAnswers = [answer('destination', 'PT'), answer('goals', ['residence']), answer('applicantNationality', 'CN')];
export async function seeded(request: APIRequestContext, answers = fullAnswers) {
    await login(request);
    const made = await create(request);
    await settle(request, made.conversation.id);
    await send(request, made.conversation.id, '已选择', answers);
    await settle(request, made.conversation.id);
    return made.conversation.id;
}
export async function plan(request: APIRequestContext, conversationId: string, allowIncomplete = false) {
    return parsed(await request.post(`/api/conversations/${conversationId}/plan`, { data: { allowIncomplete } }), planResponseSchema, 201);
}
export async function waitRunning(request: APIRequestContext, conversationId: string) {
    await expect.poll(async () => conversationResponseSchema.parse(await (await request.get(`/api/conversations/${conversationId}`)).json()).activeTurn?.status, { intervals: [10, 20, 50], timeout: 10000 }).toBe('running');
    return detail(request, conversationId);
}
