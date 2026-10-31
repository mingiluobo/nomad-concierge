import { InterpreterError, abortError, throwIfAborted } from '../interpreter.js';

export interface ClientConfig { baseUrl: string; model: string; apiKey: string; timeoutMs: number }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export class OpenAICompatibleClient {
  constructor(private readonly config: ClientConfig) {}
  async complete(messages: ChatMessage[], externalSignal: AbortSignal): Promise<unknown> {
    throwIfAborted(externalSignal);
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const signal = AbortSignal.any([externalSignal, timeout]);
    let raw: unknown;
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, messages, temperature: 0, max_tokens: 800, response_format: { type: 'json_object' } }),
      });
      if (!response.ok) throw new InterpreterError('unavailable', `Model endpoint returned HTTP ${response.status}`);
      try { raw = await response.json(); } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof SyntaxError) throw new InterpreterError('invalid_output', 'Model endpoint did not return JSON');
        throw error;
      }
    } catch (error) {
      if (externalSignal.aborted) throw abortError(externalSignal);
      if (timeout.aborted) throw new InterpreterError('timeout', 'Model request exceeded its deadline');
      if (error instanceof InterpreterError) throw error;
      throw new InterpreterError('unavailable', 'Model endpoint could not be reached');
    }
    throwIfAborted(externalSignal);
    const content = typeof raw === 'object' && raw !== null && 'choices' in raw && Array.isArray(raw.choices)
      ? (raw.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content : undefined;
    if (typeof content !== 'string') throw new InterpreterError('invalid_output', 'Model response is missing message content');
    try { return JSON.parse(content) as unknown; } catch {
      const unfenced = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try { return JSON.parse(unfenced) as unknown; } catch { throw new InterpreterError('invalid_output', 'Model content is not valid JSON'); }
    }
  }
}
