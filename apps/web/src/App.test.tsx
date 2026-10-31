import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TID } from '@nomad/shared';
import type { ConversationDetailDto, MessageDto, RuntimeLimits, TurnDto } from '@nomad/shared';
import { AppRoutes } from './App';
import { StoreProvider } from './store/context';
import { api, ApiError } from './api/client';
import { FakeSocket } from './test/FakeSocket';
import { assistant, conversation, message, plan, turn } from './test/fixtures';

interface Options { path?: string; anonymous?: boolean; conversation?: ConversationDetailDto; messages?: MessageDto[]; nextCursor?: number | null; active?: TurnDto; latest?: TurnDto; limits?: RuntimeLimits }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function setup(options: Options = {}) {
  const sockets: FakeSocket[] = [];
  vi.stubGlobal('WebSocket', class extends FakeSocket { constructor() { super(); sockets.push(this); } });
  const item = options.conversation;
  const me = vi.spyOn(api, 'me');
  if (options.anonymous) me.mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'login required'));
  else me.mockResolvedValue({ user: { id: 'u', username: 'User' }, limits: options.limits });
  vi.spyOn(api, 'conversations').mockResolvedValue({ items: item ? [item] : [], readStates: [], activeTurns: options.active ? [options.active] : [] });
  vi.spyOn(api, 'engines').mockResolvedValue({ engines: [{ id: 'rules', available: true }, { id: 'remote', available: false, reason: 'not_configured' }, { id: 'local', available: false, reason: 'not_configured' }] });
  vi.spyOn(api, 'conversation').mockResolvedValue({ conversation: item ?? conversation(), activeTurn: options.active ?? null, latestTurn: options.latest ?? options.active ?? null, plan: null, readState: { lastReadSeq: 0 } });
  vi.spyOn(api, 'messages').mockResolvedValue({ items: options.messages ?? [], nextCursor: options.nextCursor ?? null });
  vi.spyOn(api, 'plans').mockResolvedValue({ items: [plan()] });
  vi.spyOn(api, 'plan').mockResolvedValue({ plan: plan() });
  vi.spyOn(api, 'read').mockResolvedValue({ lastReadSeq: 2 });
  render(<MemoryRouter initialEntries={[options.path ?? '/?new=1']}><StoreProvider><AppRoutes /></StoreProvider></MemoryRouter>);
  if (options.anonymous) await screen.findByTestId(TID.loginSubmit);
  else {
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => { sockets[0]!.open(); sockets[0]!.frame({ type: 'ready', userId: 'u', latestEventId: 0 }); });
    await waitFor(() => expect(screen.getByTestId(TID.connectionStatus)).toHaveTextContent('实时连接正常'));
  }
  return sockets;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
describe('page interactions against API contracts', () => {
  it('offers a session retry after a network error and only asks for login after an actual 401', async () => {
    const me = vi.spyOn(api, 'me').mockRejectedValueOnce(new TypeError('offline')).mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', 'expired'));
    render(<MemoryRouter><StoreProvider><AppRoutes /></StoreProvider></MemoryRouter>);
    fireEvent.click(await screen.findByTestId('session-retry'));
    expect(screen.queryByTestId(TID.loginUsername)).not.toBeInTheDocument();
    await screen.findByTestId(TID.loginUsername);
    expect(me).toHaveBeenCalledTimes(2);
  });
  it('validates the login name locally and trims the submitted name', async () => {
    const login = vi.spyOn(api, 'login').mockResolvedValue({ user: { id: 'u', username: 'Alice' }, limits: { messageChars: 100, messagesPerConversation: 50 } });
    await setup({ anonymous: true, path: '/login' });
    fireEvent.change(screen.getByTestId(TID.loginUsername), { target: { value: ' a ' } });
    fireEvent.click(screen.getByTestId(TID.loginSubmit));
    expect(screen.getByTestId(TID.loginError)).toHaveTextContent('2～32'); expect(login).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId(TID.loginUsername), { target: { value: '  Alice  ' } });
    fireEvent.click(screen.getByTestId(TID.loginSubmit));
    await waitFor(() => expect(login).toHaveBeenCalledWith('Alice'));
  });
  it('puts examples into the composer without creating or sending anything', async () => {
    const create = vi.spyOn(api, 'createConversation');
    await setup();
    fireEvent.click(screen.getByTestId(TID.exampleCard(2)));
    expect(screen.getByTestId(TID.composerInput)).toHaveValue('我想搬到智利生活，需要准备什么？');
    expect(create).not.toHaveBeenCalled(); expect(screen.getByTestId(TID.disclaimerBar)).toHaveTextContent('不能替代持牌专业人士');
  });
  it('finishes creating a consultation when its event arrives before the create response', async () => {
    const gate = deferred<Awaited<ReturnType<typeof api.createConversation>>>();
    const create = vi.spyOn(api, 'createConversation').mockReturnValue(gate.promise);
    const sockets = await setup({ path: '/' });
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: '想去葡萄牙' } }); fireEvent.click(screen.getByTestId(TID.composerSend));
    act(() => sockets[0]!.frame({ type: 'event', id: 1, eventType: 'conversation.upserted', conversationId: 'c', createdAt: conversation().createdAt, payload: { conversation: conversation() } }));
    expect(screen.getByTestId(TID.messagePending)).toHaveTextContent('想去葡萄牙');
    expect(screen.getByTestId(TID.chatTitle)).toHaveTextContent('开始你的第一次咨询');
    const clientId = create.mock.calls[0]![1];
    await act(async () => gate.resolve({ conversation: conversation(), message: message(1, clientId), turn: turn() }));
    await waitFor(() => expect(screen.getByTestId(TID.chatTitle)).toHaveTextContent('葡萄牙 · 个人'));
    fireEvent.click(screen.getByTestId(TID.newConversation));
    await waitFor(() => expect(screen.getByTestId(TID.chatTitle)).toHaveTextContent('开始你的第一次咨询'));
    expect(screen.queryByTestId(TID.messagePending)).not.toBeInTheDocument();
  });
  it('discards a delayed older-message response and cursor after a real resync snapshot', async () => {
    const sockets = await setup({ path: '/c/c', conversation: conversation(), messages: [message(3)], nextCursor: 3 });
    const gate = deferred<Awaited<ReturnType<typeof api.messages>>>();
    vi.mocked(api.messages).mockReturnValueOnce(gate.promise).mockResolvedValue({ items: [message(4), message(5)], nextCursor: 4 });
    fireEvent.click(screen.getByTestId(TID.loadOlder));
    await waitFor(() => expect(api.messages).toHaveBeenCalledWith('c', 3));
    await act(async () => { sockets[0]!.frame({ type: 'resync_required' }); sockets[0]!.frame({ type: 'ready', userId: 'u', latestEventId: 9 }); });
    await screen.findByTestId(TID.message(5));
    await act(async () => gate.resolve({ items: [message(1), message(2)], nextCursor: null }));
    expect(screen.queryByTestId(TID.message(1))).not.toBeInTheDocument(); expect(screen.getByTestId(TID.loadOlder)).toBeEnabled();
    fireEvent.click(screen.getByTestId(TID.loadOlder));
    await waitFor(() => expect(api.messages).toHaveBeenCalledWith('c', 4));
  });
  it('preserves the same clientMessageId when retrying a failed send', async () => {
    const send = vi.spyOn(api, 'send').mockRejectedValueOnce(new TypeError('offline')).mockImplementationOnce(async (_id, _content, clientMessageId) => ({ message: message(3, clientMessageId), turn: turn() }));
    await setup({ path: '/c/c', conversation: conversation(), messages: [message(), assistant()] });
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: '我是中国籍' } }); fireEvent.click(screen.getByTestId(TID.composerSend));
    fireEvent.click(await screen.findByTestId(TID.messageRetrySend));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[0]?.[2]).toBe(send.mock.calls[1]?.[2]);
    await waitFor(() => expect(screen.queryByTestId(TID.messagePending)).not.toBeInTheDocument());
  });
  it('enables only the newest assistant quick answers and sends the slot-specific payload', async () => {
    const send = vi.spyOn(api, 'send').mockImplementation(async (_id, _content, clientMessageId) => ({ message: message(5, clientMessageId), turn: turn() }));
    await setup({ path: '/c/c', conversation: conversation(), messages: [message(), assistant(2), assistant(4)] });
    const buttons = screen.getAllByTestId(TID.quickReply('destination', 0));
    expect(buttons[0]).toBeDisabled(); expect(buttons[1]).toBeEnabled(); fireEvent.click(buttons[1]!);
    await waitFor(() => expect(send).toHaveBeenCalledWith('c', '葡萄牙', expect.any(String), { answers: [{ slot: 'destination', value: 'PT', label: '葡萄牙' }] }));
  });
  it('uses manual-entry choices only to focus the composer and keeps process details collapsed', async () => {
    const send = vi.spyOn(api, 'send');
    await setup({ path: '/c/c', conversation: conversation(), messages: [assistant()] });
    expect(screen.getByTestId(TID.processInfo)).not.toHaveAttribute('open');
    fireEvent.click(screen.getByTestId('quick-input-destination-0'));
    expect(screen.getByTestId(TID.composerInput)).toHaveFocus(); expect(screen.getByTestId(TID.composerInput)).toHaveAttribute('placeholder', '请输入目的国'); expect(send).not.toHaveBeenCalled();
  });
  it('lets the user stop with Escape and retry the latest interrupted turn', async () => {
    const cancel = vi.spyOn(api, 'cancel').mockResolvedValue({ turn: turn(2, 'cancelled') });
    const retry = vi.spyOn(api, 'retry').mockResolvedValue({ turn: { ...turn(), id: 'next-turn', createdAt: '2026-10-31T08:00:01.000Z' } });
    await setup({ path: '/c/c', conversation: conversation(), active: turn() });
    expect(screen.getByTestId(TID.composerInput)).toHaveAttribute('placeholder', '正在回复，继续输入会补充到这一轮');
    fireEvent.keyDown(screen.getByTestId(TID.composerInput), { key: 'Escape' });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('c', 't'));
    fireEvent.click(await screen.findByTestId(TID.turnRetry));
    await waitFor(() => expect(retry).toHaveBeenCalledWith('c', 't')); expect(await screen.findByTestId(TID.turnProgress)).toBeInTheDocument();
  });
  it('requires early-generation confirmation and renders the full plan with a completed conversation banner', async () => {
    const item = conversation(); item.progress.canGenerateEarly = true;
    const generate = vi.spyOn(api, 'generate').mockResolvedValue({ plan: plan() });
    await setup({ path: '/c/c', conversation: item });
    fireEvent.click(screen.getByTestId(TID.generateEarly));
    expect(screen.getByTestId(TID.generateDialog)).toHaveTextContent('生成后这个咨询会结束'); expect(generate).not.toHaveBeenCalled();
    vi.mocked(api.conversation).mockResolvedValue({ conversation: { ...item, status: 'completed', planId: 'p', version: 2 }, activeTurn: null, latestTurn: null, plan: plan(), readState: { lastReadSeq: 0 } });
    fireEvent.click(screen.getByTestId(TID.generateConfirm));
    await screen.findByTestId(TID.planFirstStep);
    expect(generate).toHaveBeenCalledWith('c', true);
    expect(screen.getByTestId(TID.planUnknown)).toHaveTextContent('计划时间'); expect(screen.getByTestId(TID.planBoundary)).toHaveTextContent('请咨询持牌专业人士'); expect(screen.getByTestId(TID.planDisclaimer)).toHaveTextContent('不能替代');
    fireEvent.click(screen.getByTestId('plan-conversation'));
    await screen.findByTestId(TID.composerCompletedBanner); expect(screen.queryByTestId(TID.composerInput)).not.toBeInTheDocument();
  });
  it('keeps the generate button clickable during a turn but explains why it must wait', async () => {
    const item = conversation(); item.progress.isComplete = true;
    const generate = vi.spyOn(api, 'generate');
    await setup({ path: '/c/c', conversation: item, active: turn() });
    expect(screen.getByTestId(TID.generatePlan)).toBeEnabled(); fireEvent.click(screen.getByTestId(TID.generatePlan));
    expect(screen.getByText('正在回复，请稍候。')).toBeInTheDocument(); expect(generate).not.toHaveBeenCalled();
  });
  it('highlights the latest retry when generation finds unprocessed messages', async () => {
    const item = conversation(); item.progress.isComplete = true;
    vi.spyOn(api, 'generate').mockRejectedValue(new ApiError(409, 'UNPROCESSED_MESSAGES', 'unprocessed'));
    await setup({ path: '/c/c', conversation: item, latest: turn(2, 'cancelled') });
    fireEvent.click(screen.getByTestId(TID.generatePlan));
    expect(await screen.findByTestId(TID.unprocessedHint)).toHaveTextContent('请先重试');
    expect(screen.getByTestId(TID.turnCancelled)).toHaveClass('highlight');
  });
});
describe('server-provided limits and authoritative errors', () => {
  it('uses a low character limit and keeps Shift+Enter from sending', async () => {
    const send = vi.spyOn(api, 'send');
    await setup({ path: '/c/c', conversation: conversation(), limits: { messageChars: 10, messagesPerConversation: 200 } });
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: '12345678901' } });
    expect(screen.getByTestId(TID.composerSend)).toBeDisabled(); expect(screen.getByTestId('composer-counter')).toHaveTextContent('11 / 10');
    fireEvent.keyDown(screen.getByTestId(TID.composerInput), { key: 'Enter' }); expect(send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: 'short' } }); fireEvent.keyDown(screen.getByTestId(TID.composerInput), { key: 'Enter', shiftKey: true }); expect(send).not.toHaveBeenCalled();
  });
  it('accepts a configured character limit above the default', async () => {
    await setup({ limits: { messageChars: 5000, messagesPerConversation: 400 } });
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: 'a'.repeat(2500) } }); expect(screen.getByTestId(TID.composerSend)).toBeEnabled();
  });
  it('falls back to the documented default when limits are absent', async () => {
    await setup(); fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: 'a'.repeat(2001) } }); expect(screen.getByTestId(TID.composerSend)).toBeDisabled(); expect(screen.getByTestId('composer-counter')).toHaveTextContent('2001 / 2000');
  });
  it.each([[4, 2, false], [4, 3, true], [400, 250, false]] as const)('uses message limit %s at count %s after refresh', async (limit, count, full) => {
    const item = conversation(); item.messageCount = count;
    await setup({ path: '/c/c', conversation: item, limits: { messageChars: 2000, messagesPerConversation: limit } });
    if (full) { expect(screen.getByTestId(TID.composerFullBanner)).toHaveTextContent('已达上限'); expect(screen.queryByTestId(TID.composerInput)).not.toBeInTheDocument(); }
    else { expect(screen.getByTestId(TID.composerInput)).toBeInTheDocument(); expect(screen.queryByTestId(TID.composerFullBanner)).not.toBeInTheDocument(); }
  });
  it('preserves input and the failed message when the server rejects text despite local validation', async () => {
    vi.spyOn(api, 'send').mockRejectedValue(new ApiError(422, 'MESSAGE_TOO_LONG', 'too long'));
    await setup({ path: '/c/c', conversation: conversation() });
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: '保留这条待编辑的消息' } }); fireEvent.click(screen.getByTestId(TID.composerSend));
    await screen.findByTestId(TID.messageRetrySend);
    expect(screen.getByTestId(TID.composerInput)).toHaveValue('保留这条待编辑的消息'); expect(screen.getByTestId('workspace-error')).toHaveTextContent('消息太长');
  });
  it('still honors a server full error and retains the failed draft', async () => {
    vi.spyOn(api, 'send').mockRejectedValue(new ApiError(422, 'CONVERSATION_FULL', 'full'));
    await setup({ path: '/c/c', conversation: conversation() });
    fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: '这条不能丢' } }); fireEvent.click(screen.getByTestId(TID.composerSend));
    await screen.findByTestId(TID.composerFullBanner); expect(screen.getByTestId(TID.messagePending)).toHaveTextContent('这条不能丢');
  });
});
