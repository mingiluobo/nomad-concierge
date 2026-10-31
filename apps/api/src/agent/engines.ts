import type { EngineId, EnginePreference, EngineStatus, FailureReason } from '@nomad/shared';
import type { AppConfig } from '../config.js';
import type { Interpreter, InterpreterFactory } from './interpreter.js';
import { CircuitBreaker } from './breaker.js';
import { FallbackInterpreter } from './fallback.js';
import { LlmInterpreter } from './llm/llmInterpreter.js';
import { RulesInterpreter } from './rules/index.js';

type EngineConfig = Pick<AppConfig, 'llmApiKey' | 'llmBaseUrl' | 'llmModel' | 'llmTimeoutMs' | 'localLlmBaseUrl' | 'localLlmModel' | 'localLlmTimeoutMs' | 'turnTimeoutMs' | 'breakerFailures' | 'breakerCooldownMs'>;
export class EngineRegistry implements InterpreterFactory {
  private readonly remoteBreaker: CircuitBreaker;
  private readonly localBreaker: CircuitBreaker;
  private readonly interpreters: Record<EngineId, Interpreter>;
  private localReason: 'unreachable' | 'model_missing' | undefined = 'unreachable';
  private probe?: Promise<void>;
  private controller = new AbortController();
  private interval?: ReturnType<typeof setInterval>;
  constructor(private readonly config: EngineConfig) {
    this.remoteBreaker = new CircuitBreaker(config.breakerFailures, config.breakerCooldownMs);
    this.localBreaker = new CircuitBreaker(config.breakerFailures, config.breakerCooldownMs);
    this.interpreters = {
      remote: new LlmInterpreter('remote', { baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey, model: config.llmModel, timeoutMs: config.llmTimeoutMs }),
      local: new LlmInterpreter('local', { baseUrl: config.localLlmBaseUrl, apiKey: 'local', model: config.localLlmModel, timeoutMs: config.localLlmTimeoutMs }),
      rules: new RulesInterpreter(),
    };
  }
  async start(): Promise<void> {
    if (this.interval || !this.config.localLlmModel) return;
    await this.refreshLocal();
    if (this.controller.signal.aborted) return;
    this.interval = setInterval(() => { void this.refreshLocal(); }, 60000);
    this.interval.unref();
  }
  refreshLocal(): Promise<void> {
    if (!this.config.localLlmModel || this.controller.signal.aborted) return Promise.resolve();
    if (this.probe) return this.probe;
    this.probe = (async () => {
      try {
        const response = await fetch(`${this.config.localLlmBaseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.localLlmTimeoutMs)]) });
        if (!response.ok) { this.localReason = 'unreachable'; return; }
        const body: unknown = await response.json();
        const list = typeof body === 'object' && body !== null && 'data' in body && Array.isArray(body.data) ? body.data : [];
        this.localReason = list.some((item: unknown) => typeof item === 'object' && item !== null && 'id' in item && item.id === this.config.localLlmModel) ? undefined : 'model_missing';
      } catch { this.localReason = 'unreachable'; }
      finally { this.probe = undefined; }
    })();
    return this.probe;
  }
  status(): EngineStatus[] {
    const status = (id: 'remote' | 'local', configured: boolean, breaker: CircuitBreaker, reason?: EngineStatus['reason']): EngineStatus => {
      const unavailable = !configured ? 'not_configured' : !breaker.available() ? 'circuit_open' : reason;
      return { id, available: !unavailable, ...(unavailable ? { reason: unavailable } : {}), ...(configured ? { model: id === 'remote' ? this.config.llmModel : this.config.localLlmModel } : {}) };
    };
    return [status('remote', Boolean(this.config.llmApiKey), this.remoteBreaker), status('local', Boolean(this.config.localLlmModel), this.localBreaker, this.localReason), { id: 'rules', available: true }];
  }
  forPreference(preference: EnginePreference): Interpreter {
    const order: Record<EnginePreference, EngineId[]> = { auto: ['remote', 'local', 'rules'], remote: ['remote', 'rules'], local: ['local', 'rules'], rules: ['rules'] };
    return new FallbackInterpreter(order[preference].map(id => ({
      id, interpreter: this.interpreters[id],
      ...(id === 'rules' ? {} : { timeoutMs: id === 'remote' ? this.config.llmTimeoutMs : this.config.localLlmTimeoutMs, breaker: id === 'remote' ? this.remoteBreaker : this.localBreaker }),
      unavailable: (): FailureReason | undefined => { const state = this.status().find(item => item.id === id)!; return state.available ? undefined : state.reason === 'circuit_open' ? 'circuit_open' : 'unavailable'; },
    })), this.config.turnTimeoutMs);
  }
  dispose(): void { clearInterval(this.interval); this.controller.abort(); }
}
export function createInterpreterFactory(config: EngineConfig): EngineRegistry { return new EngineRegistry(config); }
