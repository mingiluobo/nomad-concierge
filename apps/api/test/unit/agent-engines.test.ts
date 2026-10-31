import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import { loadConfig } from '../../src/config.js';
import { EngineRegistry } from '../../src/agent/engines.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const input = { profile: createEmptyProfile(), pendingSlots: [], recentMessages: [], newMessages: [{ id: 'm', content: '下个月' }] };
async function fake() {
  const control = { models: ['fake-model'], status: 200, content: JSON.stringify({ intent: 'provide_info', updates: [{ slot: 'timeline', value: 'lt3m' }], unsure: [] }), calls: [] as { url?: string; model?: string }[] };
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    control.calls.push({ url: request.url, ...(raw ? { model: (JSON.parse(raw) as { model: string }).model } : {}) });
    response.statusCode = control.status;
    response.end(request.url === '/v1/models' ? JSON.stringify({ data: control.models.map(id => ({ id })) }) : JSON.stringify({ choices: [{ message: { content: control.content } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { control, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}
function registry(environment: NodeJS.ProcessEnv = {}) {
  const instance = new EngineRegistry(loadConfig(environment)); cleanups.push(() => instance.dispose()); return instance;
}

describe('engine registry', () => {
  it('does not probe any endpoint in the default model-free configuration', async () => {
    const instance = registry();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await instance.start();
      const result = await instance.forPreference('auto').interpret(input, new AbortController().signal);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(instance.status()).toEqual([{ id: 'remote', available: false, reason: 'not_configured' }, { id: 'local', available: false, reason: 'not_configured' }, { id: 'rules', available: true }]);
      expect(result.fallbacks).toEqual([{ engine: 'remote', reason: 'unavailable' }, { engine: 'local', reason: 'unavailable' }]);
    } finally { fetchSpy.mockRestore(); }
  });
  it('probes the configured local model and exposes model_missing and unreachable distinctly', async () => {
    const { baseUrl, control } = await fake();
    const instance = registry({ LOCAL_LLM_MODEL: 'fake-model', LOCAL_LLM_BASE_URL: baseUrl });
    await instance.start(); expect(instance.status()[1]).toMatchObject({ available: true, model: 'fake-model' });
    control.models = ['another-model']; await instance.refreshLocal(); expect(instance.status()[1]).toMatchObject({ available: false, reason: 'model_missing' });
    control.status = 500; await instance.refreshLocal(); expect(instance.status()[1]).toMatchObject({ available: false, reason: 'unreachable' });
  });
  it.each(['auto', 'remote', 'local', 'rules'] as const)('respects the %s preference without using an unintended engine', async preference => {
    const { baseUrl, control } = await fake();
    const instance = registry({ LLM_API_KEY: 'fake-key', LLM_BASE_URL: baseUrl, LLM_MODEL: 'remote-model', LOCAL_LLM_MODEL: 'fake-model', LOCAL_LLM_BASE_URL: baseUrl });
    await instance.start(); control.calls = [];
    const result = await instance.forPreference(preference).interpret(input, new AbortController().signal);
    const expected = preference === 'auto' ? 'remote' : preference;
    expect(result.engineUsed).toBe(expected);
    expect(control.calls.filter(call => call.url?.endsWith('/chat/completions')).map(call => call.model)).toEqual(expected === 'rules' ? [] : [expected === 'remote' ? 'remote-model' : 'fake-model']);
  });
  it('opens the remote circuit after failures, reports it and recovers after a half-open success', async () => {
    const { baseUrl, control } = await fake();
    control.content = 'broken';
    const instance = registry({ LLM_API_KEY: 'fake-key', LLM_BASE_URL: baseUrl, BREAKER_FAILURES: '3', BREAKER_COOLDOWN_MS: '20' });
    for (let i = 0; i < 3; i += 1) expect((await instance.forPreference('remote').interpret(input, new AbortController().signal)).fallbacks).toEqual([{ engine: 'remote', reason: 'invalid_output' }]);
    expect(instance.status()[0]).toMatchObject({ available: false, reason: 'circuit_open' });
    expect((await instance.forPreference('remote').interpret(input, new AbortController().signal)).fallbacks).toEqual([{ engine: 'remote', reason: 'circuit_open' }]);
    control.content = JSON.stringify({ intent: 'provide_info', updates: [], unsure: [] });
    await vi.waitFor(() => expect(instance.status()[0]?.available).toBe(true), { timeout: 1000, interval: 5 });
    expect((await instance.forPreference('remote').interpret(input, new AbortController().signal)).engineUsed).toBe('remote');
    expect(instance.status()[0]?.available).toBe(true);
  });
});
