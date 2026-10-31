import { randomUUID } from 'node:crypto';
import { expect, type APIResponse, type Page, type WebSocketRoute } from '@playwright/test';
import { TID } from '../../packages/shared/src/testids.js';
import {
  conversationResponseSchema, createConversationResponseSchema, messagesResponseSchema,
  postMessageResponseSchema, planResponseSchema,
  type MessageDto, type StructuredAnswer,
} from '../../packages/shared/src/dto.js';

export const FAMILY_EXAMPLE = '我和配偶打算明年带孩子搬到葡萄牙生活，想开一家公司，也需要了解报税和孩子上学的问题，请告诉我该怎么办。';
export const EARLY_PROFILE = '我是中国人，想搬到葡萄牙生活。';

async function successful(response: APIResponse): Promise<unknown> {
  expect(response.ok(), `${response.url()}: ${response.status()}`).toBeTruthy();
  return response.json() as Promise<unknown>;
}

/** Uses the page's browser-context request session, so HTTP and UI share identity. */
export class WorkspacePage {
  constructor(readonly page: Page) {}

  async login(username = `qa-${randomUUID().slice(0, 20)}`) {
    await this.page.goto('/login');
    await this.page.getByTestId(TID.loginUsername).fill(username);
    await this.page.getByTestId(TID.loginSubmit).click();
    await expect(this.page.getByTestId(TID.newConversation)).toBeVisible();
    await this.live();
    return username;
  }

  async live() {
    await expect(this.page.getByTestId(TID.connectionStatus)).toContainText('实时连接正常', { timeout: 20_000 });
  }

  async open(id: string) {
    await this.page.goto(`/c/${id}`);
    await this.live();
    await expect(this.page.getByTestId(TID.profilePanel)).toBeVisible();
  }

  async send(content: string) {
    const endpoint = /\/api\/conversations(?:\/[^/]+\/messages)?$/;
    const responsePromise = this.page.waitForResponse(response => response.request().method() === 'POST' && endpoint.test(new URL(response.url()).pathname));
    await this.page.getByTestId(TID.composerInput).fill(content);
    await this.page.getByTestId(TID.composerSend).click();
    const response = await responsePromise;
    expect([201, 202]).toContain(response.status());
    const body = await response.json() as unknown;
    return response.status() === 201
      ? createConversationResponseSchema.parse(body).conversation.id
      : postMessageResponseSchema.parse(body).message.conversationId;
  }

  async detail(id: string) {
    return conversationResponseSchema.parse(await successful(await this.page.request.get(`/api/conversations/${id}`)));
  }

  async messages(id: string, before?: number, limit = 100) {
    return messagesResponseSchema.parse(await successful(await this.page.request.get(`/api/conversations/${id}/messages`, {
      params: { limit, ...(before === undefined ? {} : { before }) },
    })));
  }

  async settled(id: string) {
    await expect.poll(async () => (await this.detail(id)).activeTurn, { timeout: 35_000, message: 'The public conversation snapshot has no active reply task' }).toBeNull();
    const result = await this.detail(id);
    expect(result.latestTurn?.status).toBe('completed');
    const messages = await this.messages(id);
    const assistant = [...messages.items].reverse().find(message => message.role === 'assistant');
    expect(assistant, 'A completed reply must have a durable assistant message').toBeDefined();
    return result;
  }

  async latestAssistant(id: string) {
    const messages = await this.messages(id);
    const assistant = [...messages.items].reverse().find(message => message.role === 'assistant');
    if (!assistant || assistant.role !== 'assistant' || !assistant.payload) throw new Error('Expected a structured assistant reply');
    return assistant;
  }

  async create(content = EARLY_PROFILE) {
    const result = createConversationResponseSchema.parse(await successful(await this.page.request.post('/api/conversations', {
      data: { content, clientMessageId: randomUUID(), enginePreference: 'rules' },
    })));
    await this.settled(result.conversation.id);
    return result.conversation.id;
  }

  async post(id: string, content: string, answers?: StructuredAnswer[]) {
    return postMessageResponseSchema.parse(await successful(await this.page.request.post(`/api/conversations/${id}/messages`, {
      data: { content, clientMessageId: randomUUID(), ...(answers ? { payload: { answers } } : {}) },
    })));
  }

  async quick(id: string, slot: string, value: unknown) {
    const assistant = await this.latestAssistant(id);
    const question = assistant.payload!.questions.find(question => question.slot === slot);
    expect(question, `Expected the latest reply to ask ${slot}`).toBeDefined();
    const index = question!.options.findIndex(option => JSON.stringify(option.value) === JSON.stringify(value));
    expect(index, `Expected a contractual quick option for ${slot}`).toBeGreaterThanOrEqual(0);
    await this.page.getByTestId(TID.message(assistant.seq)).getByTestId(TID.quickReply(slot, index)).click();
    await expect.poll(async () => (await this.messages(id)).items.at(-1)?.seq).toBeGreaterThan(assistant.seq);
    await this.settled(id);
  }

  async generateEarly(id: string) {
    const result = planResponseSchema.parse(await successful(await this.page.request.post(`/api/conversations/${id}/plan`, {
      data: { allowIncomplete: true },
    })));
    return result.plan;
  }

  async assertMessages(messages: MessageDto[]) {
    for (const message of messages) {
      const card = this.page.getByTestId(TID.message(message.seq));
      await expect(card).toHaveCount(1);
      if (message.role === 'user' || !message.payload) {
        await expect(card).toContainText(message.content);
      } else {
        for (const notice of message.payload.notices) await expect(card.getByTestId(TID.notice(notice.kind))).toContainText(notice.text);
        for (const recorded of message.payload.recorded) await expect(card.getByTestId(TID.recordedChip(recorded.slot))).toContainText(recorded.display);
        for (const correction of message.payload.corrections) {
          await expect(card.getByTestId(TID.correction(correction.slot))).toContainText(correction.from);
          await expect(card.getByTestId(TID.correction(correction.slot))).toContainText(correction.to);
        }
        for (const question of message.payload.questions) await expect(card).toContainText(question.text);
        await expect(card.getByTestId(TID.processInfo)).not.toBeEmpty();
      }
    }
  }
}

/** Holds real HTTP/WS traffic; it never creates product responses or events. */
export class RealSocketGate {
  online = true;
  frames: Array<Record<string, unknown>> = [];
  connections = new Set<WebSocketRoute>();

  async attach(page: Page) {
    await page.routeWebSocket('**/ws', client => {
      if (!this.online) {
        client.close({ code: 1012, reason: 'QA connection interruption' });
        return;
      }
      this.connections.add(client);
      const server = client.connectToServer();
      client.onMessage(message => server.send(message));
      server.onMessage(message => {
        const text = typeof message === 'string' ? message : message.toString();
        try { this.frames.push(JSON.parse(text) as Record<string, unknown>); } catch { /* Non-JSON frames still reach the browser. */ }
        client.send(message);
      });
      client.onClose((code, reason) => { this.connections.delete(client); server.close({ code, reason }); });
      server.onClose((code, reason) => { this.connections.delete(client); client.close({ code, reason }); });
    });
  }

  disconnect() {
    this.online = false;
    for (const connection of this.connections) connection.close({ code: 1012, reason: 'QA connection interruption' });
    this.connections.clear();
  }

  get resyncCount() { return this.frames.filter(frame => frame.type === 'resync_required').length; }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

export async function accumulateEvents(workspace: WorkspacePage, id: string) {
  let version = (await workspace.detail(id)).conversation.version;
  // Every accepted preference change has a conversation.upserted event by SPEC 12.3.
  for (let index = 0; index < 1_002; index += 1) {
    const response = await workspace.page.request.patch(`/api/conversations/${id}`, {
      data: { enginePreference: index % 2 === 0 ? 'auto' : 'rules' },
    });
    expect(response.status()).toBe(200);
    const body = await response.json() as { conversation: { version: number } };
    expect(body.conversation.version).toBeGreaterThan(version);
    version = body.conversation.version;
  }
}
