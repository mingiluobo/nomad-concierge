import { describe, expect, it } from 'vitest';
import { messageDtoSchema, planSummaryDtoSchema, postMessageRequestSchema, serverMessageSchema } from './index.js';

describe('text answer hints and plan summary metadata', () => {
  it('preserves a text answer hint in requests, messages and events', () => {
    const payload = { answeringSlot: 'applicantNationality' };
    const input = { content: '日本', clientMessageId: 'answer-id', payload };
    expect(postMessageRequestSchema.parse(input)).toEqual(input);
    const message = { id: 'message-id', conversationId: 'conversation-id', seq: 3, role: 'user', content: '日本',
      clientMessageId: 'answer-id', turnId: null, createdAt: '2026-10-31T12:00:00.000Z', payload };
    expect(messageDtoSchema.parse(message)).toEqual(message);
    const event = { type: 'event', id: 4, eventType: 'message.created', conversationId: 'conversation-id',
      createdAt: message.createdAt, payload: { message } };
    expect(serverMessageSchema.parse(event)).toEqual(event);
  });

  it('requires text for a hint, validates its slot and rejects mixed structured answers', () => {
    const request = (content: string, payload: unknown) => postMessageRequestSchema.safeParse({ content, clientMessageId: 'answer-id', payload });
    expect(request(' ', { answeringSlot: 'applicantNationality' }).success).toBe(false);
    expect(request('日本', { answeringSlot: 'not-a-slot' }).success).toBe(false);
    expect(request('日本', { answeringSlot: 'applicantNationality', answers: [{ slot: 'destination', value: 'PT', label: '葡萄牙' }] }).success).toBe(false);
    expect(request('', { answers: [{ slot: 'destination', value: 'PT', label: '葡萄牙' }] }).success).toBe(true);
  });

  it('retains plan generation metadata while accepting older summaries', () => {
    const previous = { id: 'plan-id', conversationId: 'conversation-id', title: '行动计划', destination: 'PT', coverage: 'full',
      householdSummary: '个人', goals: ['tax'], toConfirmCount: 0, createdAt: '2026-10-31T12:00:00.000Z' };
    expect(planSummaryDtoSchema.parse(previous)).toEqual(previous);
    const current = { ...previous, generatedEarly: true, knownCount: 3, unknownCount: 6 };
    expect(planSummaryDtoSchema.parse(current)).toEqual(current);
    for (const invalid of [{ knownCount: -1 }, { unknownCount: 1.5 }, { generatedEarly: 'true' }]) {
      expect(planSummaryDtoSchema.safeParse({ ...current, ...invalid }).success).toBe(false);
    }
  });
});
