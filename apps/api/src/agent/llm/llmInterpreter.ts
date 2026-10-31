import type { EngineId } from '@nomad/shared';
import { throwIfAborted, validateInterpretation } from '../interpreter.js';
import type { InterpretInput, InterpretResult, Interpreter } from '../interpreter.js';
import { OpenAICompatibleClient } from './openaiCompatibleClient.js';
import type { ClientConfig } from './openaiCompatibleClient.js';
import { buildPrompt, PROMPT_VERSION } from './prompt.js';

export class LlmInterpreter implements Interpreter {
  private readonly client: OpenAICompatibleClient;
  constructor(public readonly id: Exclude<EngineId, 'rules'>, config: ClientConfig) { this.client = new OpenAICompatibleClient(config); }
  async interpret(input: InterpretInput, signal: AbortSignal): Promise<InterpretResult> {
    throwIfAborted(signal);
    const raw = await this.client.complete(buildPrompt(input), signal);
    throwIfAborted(signal);
    return { ...validateInterpretation(raw), engineUsed: this.id, fallbacks: [], promptVersion: PROMPT_VERSION };
  }
}
