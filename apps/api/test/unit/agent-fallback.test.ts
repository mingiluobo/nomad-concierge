import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import { CircuitBreaker } from '../../src/agent/breaker.js';
import { FallbackInterpreter } from '../../src/agent/fallback.js';
import { InterpreterError } from '../../src/agent/interpreter.js';
import type { InterpretInput, InterpretResult, Interpreter } from '../../src/agent/interpreter.js';

const input: InterpretInput = { profile: createEmptyProfile(), pendingSlots: [], recentMessages: [], newMessages: [{ id: 'm', content: 'hello' }] };
const success = (engineUsed: InterpretResult['engineUsed']): InterpretResult => ({ interpretation: { intent: 'off_topic', updates: [], unsure: [] }, engineUsed, fallbacks: [], droppedUpdates: [] });
const engine = (id: InterpretResult['engineUsed'], run: Interpreter['interpret']): Interpreter => ({ id, interpret: run });
afterEach(() => vi.useRealTimers());

describe('circuit breaker', () => {
  it('opens after consecutive failures, allows only one half-open probe and closes on success', () => {
    let now = 0; const breaker = new CircuitBreaker(3, 100, () => now);
    breaker.failure(breaker.acquire()!); breaker.failure(breaker.acquire()!); expect(breaker.available()).toBe(true);
    breaker.failure(breaker.acquire()!); expect(breaker.available()).toBe(false); expect(breaker.acquire()).toBeNull();
    now = 100; const probe = breaker.acquire(); expect(probe).not.toBeNull(); expect(breaker.acquire()).toBeNull();
    breaker.success(probe!); expect(breaker.available()).toBe(true);
    breaker.failure(breaker.acquire()!); expect(breaker.available()).toBe(true);
  });
  it('failed half-open probes restart cooldown while interrupted probes do not count as failures', () => {
    let now = 0; const breaker = new CircuitBreaker(1, 100, () => now);
    breaker.failure(breaker.acquire()!); now = 100; const probe = breaker.acquire()!; breaker.interrupted(probe);
    const second = breaker.acquire(); expect(second).not.toBeNull(); breaker.failure(second!); expect(breaker.available()).toBe(false);
    now = 199; expect(breaker.available()).toBe(false); now = 200; expect(breaker.acquire()).not.toBeNull();
  });
  it('old closed requests cannot release or override a different half-open probe', () => {
    let now = 0; const breaker = new CircuitBreaker(1, 100, () => now);
    const oldRequest = breaker.acquire()!; breaker.failure(breaker.acquire()!);
    now = 100; const probe = breaker.acquire()!;
    breaker.interrupted(oldRequest); expect(breaker.acquire()).toBeNull();
    breaker.success(oldRequest); expect(breaker.acquire()).toBeNull();
    breaker.failure(oldRequest); expect(breaker.acquire()).toBeNull();
    breaker.success(probe); expect(breaker.available()).toBe(true);
  });
});

describe('fallback chain', () => {
  it('records remote timeout and local invalid output before rules', async () => {
    const chain = new FallbackInterpreter([
      { id: 'remote', timeoutMs: 15, interpreter: engine('remote', async () => new Promise(() => undefined)) },
      { id: 'local', timeoutMs: 100, interpreter: engine('local', async () => { throw new InterpreterError('invalid_output', 'bad'); }) },
      { id: 'rules', interpreter: engine('rules', async () => success('rules')) },
    ], 5000);
    const result = await chain.interpret(input, new AbortController().signal);
    expect(result.engineUsed).toBe('rules');
    expect(result.fallbacks).toEqual([{ engine: 'remote', reason: 'timeout' }, { engine: 'local', reason: 'invalid_output' }]);
  });
  it('skips unavailable engines and preserves circuit-open reasons', async () => {
    const never = vi.fn<Interpreter['interpret']>();
    const result = await new FallbackInterpreter([
      { id: 'remote', interpreter: engine('remote', never), unavailable: () => 'unavailable' },
      { id: 'local', interpreter: engine('local', never), unavailable: () => 'circuit_open' },
      { id: 'rules', interpreter: engine('rules', async () => success('rules')) },
    ], 5000).interpret(input, new AbortController().signal);
    expect(never).not.toHaveBeenCalled();
    expect(result.fallbacks).toEqual([{ engine: 'remote', reason: 'unavailable' }, { engine: 'local', reason: 'circuit_open' }]);
  });
  it('reserves two seconds and shares one budget across repeated text segments', async () => {
    let now = 0; const remote = vi.fn<Interpreter['interpret']>(async () => success('remote'));
    const chain = new FallbackInterpreter([{ id: 'remote', interpreter: engine('remote', remote), timeoutMs: 500 }, { id: 'rules', interpreter: engine('rules', async () => success('rules')) }], 2500, () => now);
    expect((await chain.interpret(input, new AbortController().signal)).engineUsed).toBe('remote');
    now = 501;
    expect((await chain.interpret(input, new AbortController().signal)).fallbacks).toEqual([{ engine: 'remote', reason: 'timeout' }]);
    expect(remote).toHaveBeenCalledTimes(1);
  });
  it('aborts immediately even if an engine ignores its signal and does not count failure', async () => {
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const breaker = new CircuitBreaker(1, 1000);
    const rules = vi.fn<Interpreter['interpret']>();
    const chain = new FallbackInterpreter([{ id: 'remote', timeoutMs: 1000, breaker, interpreter: engine('remote', async () => { began(); return new Promise(() => undefined); }) }, { id: 'rules', interpreter: engine('rules', rules) }], 5000);
    const controller = new AbortController();
    const work = chain.interpret(input, controller.signal); const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await started; controller.abort(); await rejected;
    expect(breaker.available()).toBe(true); expect(rules).not.toHaveBeenCalled();
  });
});
