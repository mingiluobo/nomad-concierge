import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyProfile, slotDefinitions } from '@nomad/shared';
import { OpenAICompatibleClient } from '../../src/agent/llm/openaiCompatibleClient.js';
import { LlmInterpreter } from '../../src/agent/llm/llmInterpreter.js';
import { buildPrompt, PROMPT_VERSION } from '../../src/agent/llm/prompt.js';
import type { InterpretInput } from '../../src/agent/interpreter.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const input = (): InterpretInput => ({ profile: createEmptyProfile(), pendingSlots: [], recentMessages: [], newMessages: [{ id: 'm', content: '我想搬到葡萄牙' }] });
async function fake(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void) {
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    handler(request, response, body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  return `http://127.0.0.1:${address.port}/v1`;
}
const response = (content: string) => JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
const legal = { intent: 'provide_info', updates: [{ slot: 'destination', value: 'PT' }], unsure: [] };

describe('OpenAI-compatible client and interpretation', () => {
  it('sends only common completion parameters and reads legal JSON', async () => {
    let captured: { url?: string; authorization?: string; body?: unknown } = {};
    const baseUrl = await fake((request, res, body) => { captured = { url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) }; res.end(response(JSON.stringify(legal))); });
    const result = await new LlmInterpreter('remote', { baseUrl, model: 'test-model', apiKey: 'fake-key', timeoutMs: 1000 }).interpret(input(), new AbortController().signal);
    expect(result).toMatchObject({ interpretation: legal, engineUsed: 'remote', fallbacks: [], droppedUpdates: [], promptVersion: 'v2' });
    expect(captured.url).toBe('/v1/chat/completions');
    expect(captured.authorization).toBe('Bearer fake-key');
    expect(captured.body).toEqual({ model: 'test-model', messages: buildPrompt(input()), temperature: 0, max_tokens: 800, response_format: { type: 'json_object' } });
  });
  it('accepts a JSON code fence', async () => {
    const baseUrl = await fake((_req, res) => res.end(response('```json\n' + JSON.stringify(legal) + '\n```')));
    const result = await new OpenAICompatibleClient({ baseUrl, model: 'fake', apiKey: '', timeoutMs: 1000 }).complete([], new AbortController().signal);
    expect(result).toEqual(legal);
  });
  it.each(['not-json', '{"choices":[]}', response('{broken'), response(JSON.stringify({ intent: 'ask_professional', updates: [], unsure: [] }))])('classifies malformed response %s', async body => {
    const baseUrl = await fake((_req, res) => res.end(body));
    await expect(new LlmInterpreter('local', { baseUrl, model: 'fake', apiKey: 'fake', timeoutMs: 1000 }).interpret(input(), new AbortController().signal)).rejects.toMatchObject({ reason: 'invalid_output' });
  });
  it.each([401, 403, 404, 429, 500])('classifies HTTP %i as unavailable', async status => {
    const baseUrl = await fake((_req, res) => { res.statusCode = status; res.end('unavailable'); });
    await expect(new OpenAICompatibleClient({ baseUrl, model: 'fake', apiKey: 'fake', timeoutMs: 1000 }).complete([], new AbortController().signal)).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('classifies a connection closed without a response as unavailable', async () => {
    const baseUrl = await fake((request) => request.socket.destroy());
    await expect(new OpenAICompatibleClient({ baseUrl, model: 'fake', apiKey: 'fake', timeoutMs: 1000 }).complete([], new AbortController().signal)).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('classifies a truncated transport response as unavailable rather than invalid JSON', async () => {
    const baseUrl = await fake((_request, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      res.write('{');
      setImmediate(() => res.destroy());
    });
    await expect(new OpenAICompatibleClient({ baseUrl, model: 'fake', apiKey: 'fake', timeoutMs: 1000 }).complete([], new AbortController().signal)).rejects.toMatchObject({ reason: 'unavailable' });
  });
  it('drops invalid values and forbidden operations without dropping legal updates', async () => {
    const baseUrl = await fake((_req, res) => res.end(response(JSON.stringify({ intent: 'provide_info', updates: [{ slot: 'destination', value: 'ZZ' }, { slot: 'childrenCount', value: 12 }, { slot: 'timeline', value: 'lt3m', op: 'add' }, { slot: 'applicantNationality', value: 'CN' }], unsure: ['destination', 'timeline'] }))));
    const result = await new LlmInterpreter('remote', { baseUrl, model: 'fake', apiKey: 'fake', timeoutMs: 1000 }).interpret(input(), new AbortController().signal);
    expect(result.interpretation).toEqual({ intent: 'provide_info', updates: [{ slot: 'applicantNationality', value: 'CN' }], unsure: ['timeline'] });
    expect(result.droppedUpdates.map(item => item.slot)).toEqual(['destination', 'childrenCount', 'timeline', 'destination']);
  });
  it('times out a real HTTP request', async () => {
    const baseUrl = await fake(() => undefined);
    await expect(new OpenAICompatibleClient({ baseUrl, model: 'fake', apiKey: 'fake', timeoutMs: 20 }).complete([], new AbortController().signal)).rejects.toMatchObject({ reason: 'timeout' });
  });
  it('preserves external cancellation and does not misclassify it as a timeout', async () => {
    let received!: () => void;
    const seen = new Promise<void>(resolve => { received = resolve; });
    const baseUrl = await fake(() => received());
    const controller = new AbortController();
    const work = new OpenAICompatibleClient({ baseUrl, model: 'fake', apiKey: 'fake', timeoutMs: 1000 }).complete([], controller.signal);
    const rejection = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await seen; controller.abort(); await rejection;
  });
  it('generates fields from the registry and excludes explicitly inapplicable context', () => {
    const request = input();
    request.profile.slots.hasPartner = { status: 'known', value: false };
    request.profile.slots.partnerNationality = { status: 'known', value: 'PT' };
    request.profile.slots.goals = { status: 'known', value: ['tax'] };
    request.profile.slots.incomeSource = { status: 'known', value: 'freelancer' };
    const prompt = buildPrompt(request);
    expect(PROMPT_VERSION).toBe('v2');
    for (const slot of slotDefinitions) expect(prompt[0]!.content).toContain(slot.llmHint);
    expect(prompt[0]!.content).toContain('不能根据用户使用的语言推断');
    expect(prompt[0]!.content).toContain('只输出newMessages');
    const context = JSON.parse(prompt[1]!.content) as { profile: Record<string, unknown> };
    expect(context.profile).not.toHaveProperty('partnerNationality');
    expect(context.profile).toHaveProperty('incomeSource', { status: 'known', value: 'freelancer' });
    expect(context.profile).not.toHaveProperty('destination');
  });
  it('describes actual JSON value types and allowed operations from the slot registry', () => {
    const system = buildPrompt(input())[0]!.content;
    const prefix = '字段定义：';
    const line = system.split('\n').find(line => line.startsWith(prefix))!;
    const fields = JSON.parse(line.slice(prefix.length)) as { key: string; valueFormat: unknown; operations: string[]; question: string; options: unknown[] }[];
    const field = (key: string) => fields.find(item => item.key === key)!;
    expect(field('hasPartner').valueFormat).toEqual({ type: 'boolean' });
    expect(field('childrenCount').valueFormat).toEqual({ type: 'integer', minimum: 0, maximum: 10 });
    expect(field('childrenAges').valueFormat).toEqual({ type: 'array', items: { type: 'integer', minimum: 0, maximum: 25 } });
    expect(field('destination').valueFormat).toEqual({ type: 'string' });
    const goalOptions = slotDefinitions.find(slot => slot.key === 'goals')!.options!;
    expect(field('goals').valueFormat).toEqual({ type: 'array', items: { type: 'string', enum: goalOptions.flatMap(option => option.value) } });
    expect(field('goals').operations).toEqual(['add', 'remove', 'set']);
    for (const definition of slotDefinitions) {
      expect(field(definition.key).question).toBe(definition.question);
      expect(field(definition.key).options).toEqual(definition.options ?? []);
      if (definition.key !== 'goals') expect(field(definition.key).operations).toEqual(['set']);
    }
  });
  it('provides ordered pending question context without changing new messages or known facts', () => {
    const request = input();
    request.pendingSlots = ['childrenCount', 'timeline'];
    request.profile.slots.currentResidence = { status: 'known', value: 'DE' };
    request.profile.slots.residenceStatus = { status: 'known', value: 'citizen' };
    request.newMessages = [{ id: 'fresh', content: '四个' }];
    const original = structuredClone(request);
    const context = JSON.parse(buildPrompt(request)[1]!.content) as { pendingSlots: string[]; pendingQuestions: unknown[]; newMessages: unknown; profile: Record<string, unknown> };
    expect(context.pendingSlots).toEqual(['childrenCount', 'timeline']);
    expect(context.pendingQuestions).toEqual(request.pendingSlots.map(key => {
      const definition = slotDefinitions.find(slot => slot.key === key)!;
      return { slot: key, question: definition.question, allowUnsure: definition.allowUnsure, options: definition.options ?? [] };
    }));
    expect(context.newMessages).toEqual(original.newMessages);
    expect(context.profile.residenceStatus).toEqual(original.profile.slots.residenceStatus);
    expect(request).toEqual(original);
  });
});
