import type { APIRequestContext, APIResponse } from '@playwright/test';
import { test, expect } from '../../fixtures/test.js';
import type { TurnDto } from '../../../packages/shared/src/dto.js';
import type { SlotKey } from '../../../packages/shared/src/profile.js';
import { slots } from '../../../packages/shared/src/slots.js';
import type { FakeLlmServer } from '../../fakes/llm-server.js';
import { id } from './support.js';

// Local wire types preserve the new payload while the source checkout's shared schema is older.
export interface RawMessage {
    id: string; conversationId: string; seq: number; role: 'user' | 'assistant'; content: string;
    clientMessageId: string | null; turnId: string | null;
    payload: Record<string, unknown> | null;
}
export async function raw<T>(response: APIResponse, statuses: number[] = [200]): Promise<T> {
    const body: unknown = await response.json();
    await test.info().attach(`raw HTTP ${response.status()} ${new URL(response.url()).pathname}`, {
        body: JSON.stringify(body, null, 2), contentType: 'application/json',
    });
    expect(statuses).toContain(response.status());
    return body as T;
}
export async function hinted(request: APIRequestContext, cid: string, content: string, answeringSlot: SlotKey, clientMessageId = id(), statuses = [202]) {
    return raw<{ message: RawMessage; turn: TurnDto | null }>(await request.post(`/api/conversations/${cid}/messages`, {
        data: { content, clientMessageId, payload: { answeringSlot } },
    }), statuses);
}
export async function rawMessages(request: APIRequestContext, cid: string) {
    return raw<{ items: RawMessage[]; nextCursor: number | null }>(await request.get(`/api/conversations/${cid}/messages?limit=100`));
}
export interface PromptContext {
    profile: unknown;
    pendingSlots: SlotKey[];
    pendingQuestions: unknown[];
    recentMessages: unknown[];
    newMessages: { id?: string; content: string }[];
}
export const modelCalls = (fake: FakeLlmServer) => fake.requests.filter(request => request.method === 'POST' && request.path.endsWith('/chat/completions'));
export function promptContext(body: unknown): PromptContext {
    const messages = (body as { messages: { role: string; content: string }[] }).messages;
    const user = messages.find(message => message.role === 'user');
    expect(user).toBeDefined();
    return JSON.parse(user!.content) as PromptContext;
}

// SPEC fixes the semantics/order, but not the question-text/container property names.
// Traverse one question entry without requiring an implementation-specific text/question alias.
export function expectPendingQuestions(context: PromptContext, expectedSlots: SlotKey[]) {
    expect(context.pendingSlots).toEqual(expectedSlots);
    expect(Array.isArray(context.pendingQuestions)).toBe(true);
    expect(context.pendingQuestions).toHaveLength(expectedSlots.length);
    expectedSlots.forEach((key, index) => {
        const definition = slots[key];
        const expectedOptions = definition.options;
        const strings: string[] = [];
        const allowUnsure: unknown[] = [];
        const optionLists: unknown[][] = [];
        function visit(value: unknown): void {
            if (typeof value === 'string') strings.push(value);
            if (Array.isArray(value)) {
                if (value.every(option => option && typeof option === 'object' && 'label' in option && 'value' in option)) optionLists.push(value);
                value.forEach(visit);
            } else if (value && typeof value === 'object') {
                for (const [name, item] of Object.entries(value)) {
                    if (name === 'allowUnsure') allowUnsure.push(item);
                    visit(item);
                }
            }
        }
        visit(context.pendingQuestions[index]);
        expect(strings, `question for ${key}`).toContain(definition.question);
        expect(allowUnsure, `allowUnsure for ${key}`).toEqual([definition.allowUnsure]);
        // SPEC 8.3 fixes registry options, but does not say whether prompt
        // entries also contain UI-only dynamic or unsure options. Do not
        // require those additions or a representation for absent options.
        if (expectedOptions?.length) {
            expect(optionLists, `registry options for ${key}`).toHaveLength(1);
            expect(optionLists[0]).toEqual(expect.arrayContaining(expectedOptions));
        }
    });
}
