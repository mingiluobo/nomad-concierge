import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TID } from '@nomad/shared';
import type { ConversationDetailDto, MessageDto, PlanDto, PlanSummaryDto } from '@nomad/shared';
import { AppRoutes } from './App';
import { StoreProvider, useStore } from './store/context';
import { api } from './api/client';
import { FakeSocket } from './test/FakeSocket';
import { assistant, conversation, message, plan, turn } from './test/fixtures';

let store: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return null; }
interface SetupOptions { path?: string; userId?: string; conversation?: ConversationDetailDto; messages?: MessageDto[]; plans?: PlanSummaryDto[]; detail?: PlanDto }
async function setup(options: SetupOptions = {}) {
  const sockets: FakeSocket[] = [];
  vi.stubGlobal('WebSocket', class extends FakeSocket { constructor() { super(); sockets.push(this); } });
  const item = options.conversation ?? conversation();
  const userId = options.userId ?? 'u';
  vi.spyOn(api, 'me').mockResolvedValue({ user: { id: userId, username: userId } });
  vi.spyOn(api, 'conversations').mockResolvedValue({ items: [item], readStates: [], activeTurns: [] });
  vi.spyOn(api, 'engines').mockResolvedValue({ engines: [{ id: 'rules', available: true }, { id: 'remote', available: false, reason: 'not_configured' }] });
  vi.spyOn(api, 'conversation').mockResolvedValue({ conversation: item, activeTurn: null, latestTurn: null, plan: null, readState: { lastReadSeq: 0 } });
  vi.spyOn(api, 'messages').mockResolvedValue({ items: options.messages ?? [], nextCursor: null });
  vi.spyOn(api, 'plans').mockResolvedValue({ items: options.plans ?? [plan(), { ...plan(), id: 'p2' }] });
  vi.spyOn(api, 'plan').mockResolvedValue({ plan: options.detail ?? plan() });
  vi.spyOn(api, 'read').mockResolvedValue({ lastReadSeq: 2 });
  render(<MemoryRouter initialEntries={[options.path ?? '/c/c']}><StoreProvider><Probe /><AppRoutes /></StoreProvider></MemoryRouter>);
  await waitFor(() => expect(sockets).toHaveLength(1));
  await act(async () => { sockets[0]!.open(); sockets[0]!.frame({ type: 'ready', userId, latestEventId: 0 }); });
  await waitFor(() => expect(screen.getByTestId(TID.connectionStatus)).toHaveTextContent('实时连接正常'));
  return sockets;
}
function countryQuestions(): MessageDto {
  const result = assistant();
  if (result.role === 'assistant' && result.payload) result.payload.questions.push({ slot: 'applicantNationality', text: '你的国籍是哪个国家？', options: [{ label: '中国', value: 'CN' }], allowUnsure: false });
  return result;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('manual answers and generation consent', () => {
  it('UX-01 binds manual text to the selected question and preserves that hint on retry only', async () => {
    const send = vi.spyOn(api, 'send').mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async (_id, _content, id) => ({ message: message(3, id), turn: turn() }));
    await setup({ messages: [countryQuestions()] });
    fireEvent.click(screen.getByTestId('quick-input-applicantNationality-1'));
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: '日本' } });
    fireEvent.click(screen.getByTestId(TID.composerSend));
    await screen.findByTestId(TID.messageRetrySend);
    expect(send).toHaveBeenLastCalledWith('c', '日本', expect.any(String), { answeringSlot: 'applicantNationality' });
    const firstId = send.mock.calls[0]![2];
    fireEvent.click(screen.getByTestId(TID.messageRetrySend));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith('c', '日本', firstId, { answeringSlot: 'applicantNationality' });
    expect(screen.getByTestId(TID.composerInput)).toHaveValue('');
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: '半年内出发' } });
    fireEvent.click(screen.getByTestId(TID.composerSend));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]![3]).toBeUndefined();
  });
  it('UX-01 clears the manual-answer hint when a structured answer is chosen', async () => {
    const send = vi.spyOn(api, 'send').mockImplementation(async (_id, _content, id) => ({ message: message(3, id), turn: turn() }));
    await setup({ messages: [countryQuestions()] });
    fireEvent.click(screen.getByTestId('quick-input-applicantNationality-1'));
    fireEvent.click(screen.getByTestId(TID.quickReply('destination', 0)));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![3]).toEqual({ answers: [{ slot: 'destination', value: 'PT', label: '葡萄牙' }] });
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: '我目前住在中国' } });
    fireEvent.click(screen.getByTestId(TID.composerSend));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]![3]).toBeUndefined();
  });
  it('UX-06 confirms that a complete consultation will end, and cancellation does not generate', async () => {
    const item = conversation(); item.progress = { ...item.progress, isComplete: true, canGenerateEarly: true, missing: [], answered: 8 };
    const generate = vi.spyOn(api, 'generate').mockResolvedValue({ plan: plan() });
    await setup({ conversation: item });
    fireEvent.click(screen.getByTestId(TID.generatePlan));
    expect(screen.getByTestId(TID.generateDialog)).toHaveTextContent('生成后这个咨询会结束，不能再补充');
    expect(generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(TID.generateCancel));
    expect(screen.queryByTestId(TID.generateDialog)).not.toBeInTheDocument(); expect(generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(TID.generatePlan)); fireEvent.click(screen.getByTestId(TID.generateConfirm));
    await waitFor(() => expect(generate).toHaveBeenCalledWith('c', false));
  });
});

describe('plans across pages', () => {
  it.each(['/c/c', '/?new=1', '/plans/p'])('UX-07 loads the full plan count on %s without visiting the plan list', async path => {
    await setup({ path });
    expect(screen.getByTestId(TID.plansNav)).toHaveTextContent('我的计划 2');
    expect(api.plans).toHaveBeenCalledTimes(1);
  });
  it('UX-07 preserves a newly received plan when an earlier plan list resolves', async () => {
    const sockets = await setup();
    let resolve!: (value: Awaited<ReturnType<typeof api.plans>>) => void;
    const stale = new Promise<Awaited<ReturnType<typeof api.plans>>>(yes => { resolve = yes; });
    vi.mocked(api.plans).mockReturnValueOnce(stale);
    let refreshing!: Promise<void>;
    act(() => { refreshing = store.loadPage(); });
    await act(async () => sockets[0]!.frame({ type: 'event', id: 1, eventType: 'plan.created', conversationId: 'c', createdAt: plan().createdAt, payload: { plan: { ...plan(), id: 'p3' } } }));
    await act(async () => { resolve({ items: [plan(), { ...plan(), id: 'p2' }] }); await refreshing; });
    expect(screen.getByTestId(TID.plansNav)).toHaveTextContent('我的计划 3');
  });
  it('UX-09 distinguishes early plans using existing information counts and exact generation times', async () => {
    const early = { ...plan(), generatedEarly: true, knownCount: 5, unknownCount: 4 };
    const full = { ...plan(), id: 'p2', generatedEarly: false, knownCount: 9, unknownCount: 0, createdAt: '2026-10-31T09:00:00.000Z' };
    await setup({ path: '/plans', plans: [early, full] });
    const a = screen.getByTestId(TID.planCard('p')); const b = screen.getByTestId(TID.planCard('p2'));
    expect(a).toHaveTextContent('信息不全时生成'); expect(a).toHaveTextContent('已知 5 项'); expect(a).toHaveTextContent('待了解 4 项');
    expect(b).toHaveTextContent('信息完整时生成'); expect(b).toHaveTextContent('已知 9 项'); expect(b).toHaveTextContent('待了解 0 项');
    expect(a.querySelector('time')).toHaveAttribute('datetime', early.createdAt); expect(b.querySelector('time')).toHaveAttribute('datetime', full.createdAt);
    expect(a.querySelector('time')?.textContent).not.toBe(b.querySelector('time')?.textContent);
  });
  it('UX-11 explains a phase that has no steps', async () => {
    const item = plan(); item.content.phases.push({ phase: 'arrival', label: '抵达后', steps: [] });
    await setup({ path: '/plans/p', detail: item });
    const section = screen.getByRole('heading', { name: '抵达后' }).parentElement!;
    expect(within(section).getByText('该阶段暂无事项')).toBeInTheDocument();
  });
});

describe('new consultation defaults', () => {
  it('UX-13 uses a new-consultation heading for a returning user', async () => {
    await setup(); fireEvent.click(screen.getByTestId(TID.newConversation));
    await waitFor(() => expect(screen.getByTestId(TID.chatTitle)).toHaveTextContent('开始新的咨询'));
    expect(screen.getByTestId(TID.chatTitle)).not.toHaveTextContent('第一次');
  });
  it('UX-14 remembers the last explicit choice across new pages and remounts without copying older conversations', async () => {
    const setEngine = vi.spyOn(api, 'setEngine').mockResolvedValue({ conversation: { ...conversation(2), enginePreference: 'auto' } });
    await setup({ path: '/?new=1' });
    fireEvent.change(screen.getByTestId(TID.engineSelect), { target: { value: 'rules' } });
    fireEvent.click(screen.getByTestId(TID.convItem('c')));
    await screen.findByTestId(TID.composerInput); expect(setEngine).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(TID.newConversation));
    await waitFor(() => expect(screen.getByTestId(TID.engineSelect)).toHaveValue('rules'));
    cleanup(); vi.restoreAllMocks();
    await setup({ path: '/?new=1' });
    expect(screen.getByTestId(TID.engineSelect)).toHaveValue('rules');
    cleanup(); vi.restoreAllMocks();
    await setup({ path: '/?new=1', userId: 'other-user' });
    expect(screen.getByTestId(TID.engineSelect)).toHaveValue('auto');
  });
});
