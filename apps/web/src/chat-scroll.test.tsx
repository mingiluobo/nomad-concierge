import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TID } from '@nomad/shared';
import type { MessageDto } from '@nomad/shared';
import { AppRoutes } from './App';
import { StoreProvider } from './store/context';
import { api } from './api/client';
import { FakeSocket } from './test/FakeSocket';
import { assistant, conversation, message, now } from './test/fixtures';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
let height: number;
let top: number;
let frames: FrameRequestCallback[];
const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { if (options.behavior !== 'smooth' && options.top !== undefined) this.scrollTop = options.top; });
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
beforeEach(() => {
  height = 1200; top = 0; frames = []; scrollTo.mockClear();
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('message-scroll') ? height : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('message-scroll') ? 400 : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => top);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(value => { top = Math.max(0, Math.min(value, height - 400)); });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    const messages = [...(this.parentElement?.children ?? [])].filter(node => node.classList.contains('message'));
    return Math.max(0, messages.indexOf(this)) * 200;
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: scrollTo });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
});
async function setup(nextCursor: number | null = null) {
  const sockets: FakeSocket[] = [];
  vi.stubGlobal('WebSocket', class extends FakeSocket { constructor() { super(); sockets.push(this); } });
  vi.spyOn(api, 'me').mockResolvedValue({ user: { id: 'u', username: 'User' } });
  vi.spyOn(api, 'conversations').mockResolvedValue({ items: [conversation(), { ...conversation(), id: 'other', title: '另一段咨询' }], readStates: [], activeTurns: [] });
  vi.spyOn(api, 'engines').mockResolvedValue({ engines: [{ id: 'rules', available: true }] });
  vi.spyOn(api, 'conversation').mockImplementation(async id => ({ conversation: { ...conversation(), id, title: id === 'c' ? '葡萄牙 · 个人' : '另一段咨询' }, activeTurn: null, latestTurn: null, plan: null, readState: { lastReadSeq: 0 } }));
  vi.spyOn(api, 'messages').mockImplementation(async id => ({ items: [message(3), assistant(4)].map(item => ({ ...item, conversationId: id })), nextCursor }));
  vi.spyOn(api, 'plans').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'read').mockResolvedValue({ lastReadSeq: 4 });
  render(<MemoryRouter initialEntries={['/c/c']}><StoreProvider><AppRoutes /></StoreProvider></MemoryRouter>);
  await waitFor(() => expect(sockets).toHaveLength(1));
  await act(async () => { sockets[0]!.open(); sockets[0]!.frame({ type: 'ready', userId: 'u', latestEventId: 0 }); });
  await screen.findByTestId(TID.composerInput);
  const node = document.querySelector<HTMLDivElement>('.message-scroll')!;
  let eventId = 0;
  return {
    node,
    position(value: number) { top = value; fireEvent.scroll(node); },
    receive(item: MessageDto) { act(() => sockets[0]!.frame({ type: 'event', id: ++eventId, eventType: 'message.created', conversationId: item.conversationId, createdAt: now, payload: { message: item } })); },
  };
}
function smoothCalls() { return scrollTo.mock.calls.filter(([options]) => options.behavior === 'smooth'); }
function sendText(text = '下个月出发') {
  fireEvent.change(screen.getByTestId(TID.composerInput), { target: { value: text } });
  fireEvent.click(screen.getByTestId(TID.composerSend));
}

describe('conversation scroll intent', () => {
  it('smoothly follows this tab sending from history, without repeating for pending confirmation', async () => {
    const gate = deferred<Awaited<ReturnType<typeof api.send>>>();
    const send = vi.spyOn(api, 'send').mockReturnValue(gate.promise);
    const chat = await setup();
    expect(top).toBe(800);
    chat.position(100); height = 1400;
    sendText();
    expect(smoothCalls()).toEqual([[{ top: 1400, behavior: 'smooth' }]]);
    const id = send.mock.calls[0]![2];
    chat.receive(message(5, id));
    expect(smoothCalls()).toHaveLength(1);
    await act(async () => gate.resolve({ message: message(5, id), turn: null }));
    expect(smoothCalls()).toHaveLength(1);
  });
  it('smoothly follows a quick answer and retry even when the message count does not change', async () => {
    const gate = deferred<Awaited<ReturnType<typeof api.send>>>();
    const send = vi.spyOn(api, 'send').mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(gate.promise);
    const chat = await setup(); chat.position(100);
    fireEvent.click(screen.getByTestId(TID.quickReply('destination', 0)));
    await screen.findByTestId(TID.messageRetrySend);
    expect(smoothCalls()).toHaveLength(1);
    chat.position(50);
    fireEvent.click(screen.getByTestId(TID.messageRetrySend));
    expect(send).toHaveBeenCalledTimes(2); expect(smoothCalls()).toHaveLength(2);
  });
  it.each([['assistant', true], ['other tab', false]] as const)('smoothly follows a new %s message when previously near the bottom', async (_label, isAssistant) => {
    const chat = await setup(); chat.position(750); height = 1600;
    chat.receive(isAssistant ? assistant(5) : message(5, 'from-another-tab'));
    expect(smoothCalls()).toEqual([[{ top: 1600, behavior: 'smooth' }]]);
  });
  it.each([['assistant', true], ['other tab', false]] as const)('keeps the reading position for a new %s message when far from the bottom', async (_label, isAssistant) => {
    const chat = await setup(); chat.position(100); height = 1600;
    chat.receive(isAssistant ? assistant(5) : message(5, 'from-another-tab'));
    expect(top).toBe(100); expect(smoothCalls()).toHaveLength(0);
  });
  it('uses the existing strict 80 pixel near-bottom threshold', async () => {
    const chat = await setup(); chat.position(720); height = 1400;
    chat.receive(assistant(5));
    expect(top).toBe(720); expect(smoothCalls()).toHaveLength(0);
  });
  it('keeps following during downward animation, but stops immediately on an upward user scroll', async () => {
    vi.spyOn(api, 'send').mockReturnValue(new Promise(() => undefined));
    const chat = await setup(); chat.position(100); height = 1400; sendText();
    chat.position(200); height = 1600; chat.receive(assistant(5));
    expect(smoothCalls()).toHaveLength(2);
    chat.position(150); height = 1800; chat.receive(assistant(6));
    expect(smoothCalls()).toHaveLength(2); expect(top).toBe(150);
  });
  it('does not mistake the start of a smooth scroll for requesting older messages', async () => {
    vi.spyOn(api, 'send').mockReturnValue(new Promise(() => undefined));
    const chat = await setup(3); top = 0; sendText(); chat.position(1);
    expect(api.messages).toHaveBeenCalledTimes(1); expect(smoothCalls()).toHaveLength(1);
  });
  it('keeps the current reading anchor on prepend without treating history as a new message', async () => {
    const chat = await setup(3); chat.position(100);
    const gate = deferred<Awaited<ReturnType<typeof api.messages>>>();
    vi.mocked(api.messages).mockReturnValueOnce(gate.promise);
    fireEvent.click(screen.getByTestId(TID.loadOlder));
    await act(async () => gate.resolve({ items: [message(1), assistant(2)], nextCursor: null }));
    height += 400;
    act(() => frames.splice(0).forEach(callback => callback(0)));
    expect(top).toBe(500); expect(smoothCalls()).toHaveLength(0);
  });
  it('anchors at the reading position when the history response arrives, not where the request began', async () => {
    const chat = await setup(3); chat.position(100);
    const gate = deferred<Awaited<ReturnType<typeof api.messages>>>();
    vi.mocked(api.messages).mockReturnValueOnce(gate.promise);
    fireEvent.click(screen.getByTestId(TID.loadOlder));
    chat.position(250);
    await act(async () => gate.resolve({ items: [message(1), assistant(2)], nextCursor: null }));
    height += 400;
    act(() => frames.splice(0).forEach(callback => callback(0)));
    expect(top).toBe(650); expect(smoothCalls()).toHaveLength(0);
  });
  it('does not let a pending history anchor override a new send from this tab', async () => {
    vi.spyOn(api, 'send').mockReturnValue(new Promise(() => undefined));
    const chat = await setup(3); chat.position(100);
    const gate = deferred<Awaited<ReturnType<typeof api.messages>>>();
    vi.mocked(api.messages).mockReturnValueOnce(gate.promise);
    fireEvent.click(screen.getByTestId(TID.loadOlder));
    await act(async () => gate.resolve({ items: [message(1), assistant(2)], nextCursor: null }));
    height += 400; sendText(); top = 300;
    act(() => frames.splice(0).forEach(callback => callback(0)));
    expect(top).toBe(300); expect(smoothCalls()).toHaveLength(1);
  });
  it('does not include a concurrent bottom append in the prepended-history offset', async () => {
    const chat = await setup(3); chat.position(100);
    const gate = deferred<Awaited<ReturnType<typeof api.messages>>>();
    vi.mocked(api.messages).mockReturnValueOnce(gate.promise);
    fireEvent.click(screen.getByTestId(TID.loadOlder));
    await act(async () => gate.resolve({ items: [message(1), assistant(2)], nextCursor: null }));
    height += 400;
    chat.receive(assistant(5)); height += 200;
    act(() => frames.splice(0).forEach(callback => callback(0)));
    expect(top).toBe(500); expect(smoothCalls()).toHaveLength(0);
  });
  it('does not overwrite a user scroll between the history render and anchor frame', async () => {
    const chat = await setup(3); chat.position(100);
    const gate = deferred<Awaited<ReturnType<typeof api.messages>>>();
    vi.mocked(api.messages).mockReturnValueOnce(gate.promise);
    fireEvent.click(screen.getByTestId(TID.loadOlder));
    await act(async () => gate.resolve({ items: [message(1), assistant(2)], nextCursor: null }));
    height += 400; chat.position(250);
    act(() => frames.splice(0).forEach(callback => callback(0)));
    expect(top).toBe(250); expect(smoothCalls()).toHaveLength(0);
  });
  it('positions a different consultation at its end and ignores the previous page anchor callback', async () => {
    const chat = await setup(3); chat.position(100);
    const gate = deferred<Awaited<ReturnType<typeof api.messages>>>();
    vi.mocked(api.messages).mockReturnValueOnce(gate.promise);
    fireEvent.click(screen.getByTestId(TID.loadOlder));
    await act(async () => gate.resolve({ items: [message(1), assistant(2)], nextCursor: null }));
    fireEvent.click(screen.getByTestId(TID.convItem('other')));
    await waitFor(() => expect(screen.getByTestId(TID.chatTitle)).toHaveTextContent('另一段咨询'));
    expect(top).toBe(800);
    top = 200;
    act(() => frames.splice(0).forEach(callback => callback(0)));
    expect(top).toBe(200); expect(smoothCalls()).toHaveLength(0);
  });
});
