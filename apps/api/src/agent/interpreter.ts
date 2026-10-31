import { interpretationSchema, slots } from '@nomad/shared';
import type { FailureReason, Interpretation } from '@nomad/shared';
export type { InterpretInput, InterpretResult, Interpreter, InterpreterFactory } from '../composition.js';

export class InterpreterError extends Error {
  constructor(public readonly reason: FailureReason, message: string, options?: ErrorOptions) { super(message, options); this.name = 'InterpreterError'; }
}
export function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error && signal.reason.name === 'AbortError' ? signal.reason : new DOMException('Interpretation interrupted', 'AbortError');
}
export function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw abortError(signal); }
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError(signal)); };
    if (signal.aborted) { void work.catch(() => undefined); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export function validateInterpretation(raw: unknown): { interpretation: Interpretation; droppedUpdates: { slot: string; reason: string }[] } {
  const parsed = interpretationSchema.safeParse(raw);
  if (!parsed.success) throw new InterpreterError('invalid_output', 'Model output does not match the interpretation structure');
  const droppedUpdates: { slot: string; reason: string }[] = [];
  const updates = parsed.data.updates.filter(update => {
    const valid = slots[update.slot].valueSchema.safeParse(update.value).success && (update.slot === 'goals' || !update.op || update.op === 'set');
    if (!valid) droppedUpdates.push({ slot: update.slot, reason: 'Invalid slot value or operation' });
    return valid;
  });
  const unsure = parsed.data.unsure.filter(slot => {
    if (slots[slot].allowUnsure) return true;
    droppedUpdates.push({ slot, reason: 'This slot does not allow unsure' });
    return false;
  });
  return { interpretation: { ...parsed.data, updates, unsure: [...new Set(unsure)] }, droppedUpdates };
}
