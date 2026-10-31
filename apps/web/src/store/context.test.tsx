import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { StoreProvider, useStore } from './context';
import { FakeSocket } from '../test/FakeSocket';
import { conversation, plan } from '../test/fixtures';

let store: ReturnType<typeof useStore>;
function Probe() { store = useStore(); return <span>{store.state.user?.username}</span>; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function setup(path = '/c/c') {
  const sockets: FakeSocket[] = [];
  vi.stubGlobal('WebSocket', class extends FakeSocket { constructor() { super(); sockets.push(this); } });
  vi.spyOn(api, 'me').mockResolvedValue({ user: { id: 'u', username: 'First' } });
  vi.spyOn(api, 'conversations').mockResolvedValue({ items: [conversation(1)], readStates: [], activeTurns: [] });
  vi.spyOn(api, 'engines').mockResolvedValue({ engines: [{ id: 'rules', available: true }] });
  vi.spyOn(api, 'conversation').mockResolvedValue({ conversation: conversation(1), activeTurn: null, latestTurn: null, plan: null, readState: { lastReadSeq: 0 } });
  vi.spyOn(api, 'messages').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'plans').mockResolvedValue({ items: [plan()] });
  vi.spyOn(api, 'plan').mockResolvedValue({ plan: plan() });
  render(<MemoryRouter initialEntries={[path]}><StoreProvider><Probe /></StoreProvider></MemoryRouter>);
  await waitFor(() => expect(sockets).toHaveLength(1));
  await act(async () => { sockets[0]!.open(); sockets[0]!.frame({ type: 'ready', userId: 'u', latestEventId: 1 }); });
  await waitFor(() => expect(store.state.connection).toBe('live'));
  return sockets;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('request generation at the provider boundary', () => {
  it.each(['/plans', '/plans/p'])('refetches %s on resync only after ready', async path => {
    const sockets = await setup(path);
    const request = path === '/plans' ? api.plans : api.plan;
    expect(request).toHaveBeenCalledTimes(1);
    act(() => sockets[0]!.frame({ type: 'resync_required' }));
    expect(store.state.planSummaries).toEqual({}); expect(store.state.planDetails).toEqual({}); expect(request).toHaveBeenCalledTimes(1);
    await act(async () => sockets[0]!.frame({ type: 'ready', userId: 'u', latestEventId: 5 }));
    await waitFor(() => expect(store.state.connection).toBe('live'));
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.state.planSummaries.p?.title).toBe('葡萄牙行动计划');
    if (path === '/plans/p') expect(store.state.planDetails.p?.content.firstStepId).toBe('passport');
  });
  it('does not let a late 401 from stale-detail refresh log out the next user', async () => {
    await setup();
    const gate = deferred<Awaited<ReturnType<typeof api.conversation>>>();
    vi.mocked(api.conversation).mockReturnValueOnce(gate.promise);
    act(() => store.dispatch({ type: 'summary', conversation: conversation(2) }));
    await waitFor(() => expect(api.conversation).toHaveBeenCalledTimes(2));
    act(() => store.dispatch({ type: 'user', user: { id: 'b', username: 'Second' } }));
    await act(async () => gate.reject(new ApiError(401, 'UNAUTHENTICATED', 'old identity')));
    expect(store.state.user?.id).toBe('b');
    expect(store.state.conversationDetails).toEqual({});
  });
  it('does not merge a late successful refresh into the next user', async () => {
    await setup();
    const gate = deferred<Awaited<ReturnType<typeof api.conversation>>>();
    vi.mocked(api.conversation).mockReturnValueOnce(gate.promise);
    act(() => store.dispatch({ type: 'summary', conversation: conversation(2) }));
    await waitFor(() => expect(api.conversation).toHaveBeenCalledTimes(2));
    act(() => store.dispatch({ type: 'user', user: { id: 'b', username: 'Second' } }));
    await act(async () => gate.resolve({ conversation: { ...conversation(2), title: 'First user private title' }, activeTurn: null, latestTurn: null, plan: null, readState: { lastReadSeq: 9 } }));
    expect(store.state.user?.id).toBe('b'); expect(store.state.conversationDetails).toEqual({}); expect(store.state.readStates).toEqual({});
  });
  it('does not fetch page snapshots until the socket ready frame arrives', async () => {
    const sockets: FakeSocket[] = [];
    vi.stubGlobal('WebSocket', class extends FakeSocket { constructor() { super(); sockets.push(this); } });
    vi.spyOn(api, 'me').mockResolvedValue({ user: { id: 'u', username: 'First' } });
    const list = vi.spyOn(api, 'conversations');
    render(<MemoryRouter><StoreProvider><Probe /></StoreProvider></MemoryRouter>);
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => sockets[0]!.open());
    expect(list).not.toHaveBeenCalled();
  });
});
