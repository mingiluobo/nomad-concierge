import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TID } from '@nomad/shared';
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
