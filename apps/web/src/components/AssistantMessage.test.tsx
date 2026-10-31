import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TID } from '@nomad/shared';
import type { AssistantPayload, EngineStatus } from '@nomad/shared';
import { AssistantMessage } from './AssistantMessage';
import { assistant } from '../test/fixtures';

afterEach(cleanup);
describe('structured assistant choices', () => {
  it('collects multiple goals then sends a single structured answer', () => {
    const value = assistant(); if (value.role !== 'assistant' || !value.payload) throw new Error('Invalid fixture');
    value.payload.questions = [{ slot: 'goals', text: '需要了解什么？', options: [{ label: '居留', value: ['residence'] }, { label: '税务', value: ['tax'] }], allowUnsure: false }];
    const answer = vi.fn(); render(<AssistantMessage payload={value.payload} enabled onAnswer={answer} onInput={vi.fn()} />);
    fireEvent.click(screen.getByTestId(TID.quickReply('goals', 0))); fireEvent.click(screen.getByTestId(TID.quickReply('goals', 1)));
    expect(answer).not.toHaveBeenCalled(); fireEvent.click(screen.getByTestId('quick-reply-goals-submit'));
    expect(answer).toHaveBeenCalledWith('居留、税务', { answers: [{ slot: 'goals', value: ['residence', 'tax'], label: '居留、税务' }] });
  });
  it('labels quick-only turns honestly and presents fallback reasons on expansion', () => {
    const value = assistant(); if (value.role !== 'assistant' || !value.payload) throw new Error('Invalid fixture');
    value.payload.process.engineUsed = null;
    const { rerender } = render(<AssistantMessage payload={value.payload} enabled onAnswer={vi.fn()} onInput={vi.fn()} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('快捷回答');
    value.payload.process = { engineUsed: 'rules', fallbacks: [{ engine: 'remote', reason: 'invalid_output' }], timings: { totalMs: 30 }, promptVersion: null };
    rerender(<AssistantMessage payload={value.payload} enabled onAnswer={vi.fn()} onInput={vi.fn()} />);
    expect(screen.getByText('已回退到规则')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('process-info-toggle'));
    expect(screen.getByTestId(TID.processInfo)).toHaveAttribute('open');
    expect(screen.getByText('DeepSeek：输出不合格')).toBeVisible();
  });
});

function processPayload(fallbacks: AssistantPayload['process']['fallbacks'], engineUsed: AssistantPayload['process']['engineUsed'] = 'rules'): AssistantPayload {
  const value = assistant(); if (value.role !== 'assistant' || !value.payload) throw new Error('Invalid fixture');
  return { ...value.payload, process: { engineUsed, fallbacks, timings: { totalMs: 12.6 }, promptVersion: null } };
}
function deepFreeze(value: object): void {
  for (const nested of Object.values(value)) if (nested && typeof nested === 'object') deepFreeze(nested);
  Object.freeze(value);
}
const unconfigured: EngineStatus[] = [
  { id: 'remote', available: false, reason: 'not_configured' },
  { id: 'local', available: false, reason: 'not_configured' },
  { id: 'rules', available: true },
];
describe('process summaries with current engine configuration', () => {
  it('uses the actual engine and elapsed time when all unavailable entries are currently unconfigured, preserving immutable history', () => {
    const payload = processPayload([{ engine: 'remote', reason: 'unavailable' }, { engine: 'local', reason: 'unavailable' }]);
    const before = structuredClone(payload); deepFreeze(payload);
    render(<AssistantMessage payload={payload} engines={unconfigured} enabled onAnswer={vi.fn()} onInput={vi.fn()} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('规则 · 13ms');
    expect(screen.getByTestId('process-info-toggle')).not.toHaveTextContent('已回退');
    fireEvent.click(screen.getByTestId('process-info-toggle'));
    expect(screen.getByText('DeepSeek：当前未配置（历史记录为不可用）')).toBeVisible();
    expect(screen.getByText('本地模型：当前未配置（历史记录为不可用）')).toBeVisible();
    expect(payload).toEqual(before); expect(Object.isFrozen(payload.process.fallbacks[0])).toBe(true);
  });
  it.each(['timeout', 'invalid_output', 'circuit_open', 'error'] as const)('retains the fallback summary for an actual %s alongside an unconfigured entry', reason => {
    const payload = processPayload([{ engine: 'remote', reason: 'unavailable' }, { engine: 'local', reason }]);
    render(<AssistantMessage payload={payload} engines={unconfigured} enabled onAnswer={vi.fn()} onInput={vi.fn()} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('已回退到规则');
    fireEvent.click(screen.getByTestId('process-info-toggle'));
    expect(screen.getByText('DeepSeek：当前未配置（历史记录为不可用）')).toBeVisible();
    expect(screen.getByText(`本地模型：${{ timeout: '超时', invalid_output: '输出不合格', circuit_open: '熔断中', error: '调用失败' }[reason]}`)).toBeVisible();
  });
  it('conservatively retains fallback for unavailable entries without matching current status', () => {
    const payload = processPayload([{ engine: 'remote', reason: 'unavailable' }, { engine: 'local', reason: 'unavailable' }]);
    const props = { payload, enabled: true, onAnswer: vi.fn(), onInput: vi.fn() };
    const { rerender } = render(<AssistantMessage {...props} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('已回退到规则');
    rerender(<AssistantMessage {...props} engines={[unconfigured[0]!]} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('已回退到规则');
    rerender(<AssistantMessage {...props} engines={[unconfigured[0]!, { id: 'local', available: false, reason: 'unreachable' }]} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('已回退到规则');
  });
  it('explicitly treats current configuration as a display hint for an unchanged historical record', () => {
    const payload = processPayload([{ engine: 'remote', reason: 'unavailable' }]); deepFreeze(payload);
    const props = { payload, enabled: true, onAnswer: vi.fn(), onInput: vi.fn() };
    const { rerender } = render(<AssistantMessage {...props} engines={unconfigured} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('规则 · 13ms');
    rerender(<AssistantMessage {...props} engines={[{ id: 'remote', available: true }]} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('已回退到规则');
    fireEvent.click(screen.getByTestId('process-info-toggle'));
    expect(screen.getByText('DeepSeek：不可用')).toBeVisible();
    expect(payload.process.fallbacks).toEqual([{ engine: 'remote', reason: 'unavailable' }]);
  });
  it('never labels a successful local interpreter as rules when only the remote interpreter was unconfigured', () => {
    const payload = processPayload([{ engine: 'remote', reason: 'unavailable' }], 'local');
    render(<AssistantMessage payload={payload} engines={unconfigured} enabled onAnswer={vi.fn()} onInput={vi.fn()} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent('本地模型 · 13ms');
    expect(screen.getByTestId('process-info-toggle')).not.toHaveTextContent('规则');
  });
  it.each([['rules', '规则'], [null, '快捷回答']] as const)('preserves a %s result with no fallback entries', (engineUsed, label) => {
    const payload = processPayload([], engineUsed);
    render(<AssistantMessage payload={payload} engines={unconfigured} enabled onAnswer={vi.fn()} onInput={vi.fn()} />);
    expect(screen.getByTestId('process-info-toggle')).toHaveTextContent(`${label} · 13ms`);
    expect(screen.getByTestId('process-info-toggle')).not.toHaveTextContent('已回退');
  });
});
