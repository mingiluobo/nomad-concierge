import type { EngineId, FailureReason } from '@nomad/shared';
import { abortable, abortError, InterpreterError, throwIfAborted } from './interpreter.js';
import type { InterpretInput, InterpretResult, Interpreter } from './interpreter.js';
import type { CircuitBreaker } from './breaker.js';

export interface ChainEntry {
  id: EngineId;
  interpreter: Interpreter;
  timeoutMs?: number;
  unavailable?: () => FailureReason | undefined;
  breaker?: CircuitBreaker;
}
export class FallbackInterpreter implements Interpreter {
  readonly id = 'chain' as const;
  private readonly deadline: number;
  constructor(private readonly entries: readonly ChainEntry[], turnTimeoutMs: number, private readonly now: () => number = Date.now) { this.deadline = now() + turnTimeoutMs; }
  async interpret(input: InterpretInput, signal: AbortSignal): Promise<InterpretResult> {
    throwIfAborted(signal);
    const fallbacks: InterpretResult['fallbacks'] = [];
    for (const entry of this.entries) {
      throwIfAborted(signal);
      const unavailable = entry.unavailable?.();
      if (unavailable) { fallbacks.push({ engine: entry.id, reason: unavailable }); continue; }
      const budget = entry.id === 'rules' ? undefined : Math.max(0, Math.min(entry.timeoutMs ?? Infinity, this.deadline - this.now() - 2000));
      if (budget === 0) { fallbacks.push({ engine: entry.id, reason: 'timeout' }); continue; }
      const permit = entry.breaker?.acquire();
      if (entry.breaker && !permit) { fallbacks.push({ engine: entry.id, reason: 'circuit_open' }); continue; }
      const timeout = budget === undefined ? undefined : AbortSignal.timeout(Math.max(1, Math.floor(budget)));
      const combined = timeout ? AbortSignal.any([signal, timeout]) : signal;
      try {
        const result = await abortable(entry.interpreter.interpret(input, combined), combined);
        throwIfAborted(signal);
        if (permit) entry.breaker?.success(permit);
        return { ...result, fallbacks: [...fallbacks, ...result.fallbacks] };
      } catch (error) {
        if (signal.aborted) { if (permit) entry.breaker?.interrupted(permit); throw abortError(signal); }
        if (permit) entry.breaker?.failure(permit);
        const reason = timeout?.aborted ? 'timeout' : error instanceof InterpreterError ? error.reason : 'error';
        fallbacks.push({ engine: entry.id, reason });
        if (entry.id === 'rules') throw error;
      }
    }
    throw new InterpreterError('error', 'The interpretation chain has no rule engine');
  }
}
