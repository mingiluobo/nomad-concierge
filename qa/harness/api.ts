import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { loginResponseSchema, createConversationResponseSchema, postMessageResponseSchema, conversationResponseSchema, messagesResponseSchema, planResponseSchema, type StructuredAnswer } from '../../packages/shared/src/dto.js';
import type { EnginePreference } from '../../packages/shared/src/states.js';

export class ApiClient {
  constructor(readonly request: APIRequestContext) {}
  id(): string { return randomUUID(); }
  async login(username = `qa-${this.id().slice(0, 12)}`) {
    const response = await this.request.post('/api/auth/login', { data: { username } });
    expect(response.status()).toBe(200);
    return loginResponseSchema.parse(await response.json());
  }
  async create(content: string, enginePreference: EnginePreference = 'rules') {
    const response = await this.request.post('/api/conversations', { data: { content, clientMessageId: this.id(), enginePreference } });
    expect(response.status()).toBe(201);
    return createConversationResponseSchema.parse(await response.json());
  }
  async send(id: string, content: string, answers?: StructuredAnswer[]) {
    const response = await this.request.post(`/api/conversations/${id}/messages`, { data: { content, clientMessageId: this.id(), ...(answers ? { payload: { answers } } : {}) } });
    expect(response.status()).toBe(202);
    return postMessageResponseSchema.parse(await response.json());
  }
  async detail(id: string) {
    const response = await this.request.get(`/api/conversations/${id}`);
    expect(response.status()).toBe(200);
    return conversationResponseSchema.parse(await response.json());
  }
  async messages(id: string, options: { before?: number; limit?: number } = {}) {
    const response = await this.request.get(`/api/conversations/${id}/messages`, { params: options });
    expect(response.status()).toBe(200);
    return messagesResponseSchema.parse(await response.json());
  }
  async settle(id: string) {
    await expect.poll(async () => (await this.detail(id)).activeTurn, { timeout: 20_000 }).toBeNull();
    return this.detail(id);
  }
  async plan(id: string, allowIncomplete = false) {
    const response = await this.request.post(`/api/conversations/${id}/plan`, { data: { allowIncomplete } });
    expect([200, 201]).toContain(response.status());
    return planResponseSchema.parse(await response.json());
  }
}
