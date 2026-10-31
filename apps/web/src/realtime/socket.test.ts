import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient } from './socket';
import { initialState, reducer } from '../store/reducer';
import type { Action } from '../store/reducer';
import { ApiError } from '../api/client';
import { message, plan } from '../test/fixtures';
import { FakeSocket } from '../test/FakeSocket';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const clients: RealtimeClient[] = [];
function setup() {
  let state = reducer(initialState(), { type: 'user', user: { id: 'u', username: 'User' } });
  const sockets: FakeSocket[] = [];
  const dispatch = (action: Action) => { state = reducer(state, action); };
  const me = vi.fn(async () => ({ user: { id: 'u', username: 'User' } }));
  const snapshot = vi.fn(async (current: () => boolean): Promise<void> => { void current; });
  const client = new RealtimeClient({ getState: () => state, dispatch, me, snapshot, createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } });
  clients.push(client); client.start(); sockets[0]!.open();
  return { client, sockets, dispatch, me, snapshot, get state() { return state; } };
}
const ready = (userId = 'u', latestEventId = 20) => ({ type: 'ready', userId, latestEventId });
afterEach(() => { clients.splice(0).forEach(client => client.stop()); vi.useRealTimers(); });
describe('WebSocket identity and synchronization', () => {
  it('buffers replay before ready and commits its cursor only after the initial snapshot succeeds', async () => {
    const test = setup(); const gate = deferred<void>(); test.snapshot.mockReturnValue(gate.promise);
    expect(JSON.parse(test.sockets[0]!.sent[0]!)).toEqual({ type: 'resume', lastEventId: null });
    test.sockets[0]!.frame({ type: 'event', id: 12, eventType: 'message.created', payload: { message: message() }, createdAt: '', conversationId: 'c' });
    expect(test.state.messages).toEqual({});
    test.sockets[0]!.frame(ready());
    expect(test.state.messages.c?.order).toEqual(['m1']); expect(test.state.lastEventId).toBe(12); expect(test.state.connection).toBe('syncing');
    gate.resolve(); await settle();
    expect(test.state.lastEventId).toBe(20); expect(test.state.connection).toBe('live');
  });
  it('never applies replay for a different identity and drops a late successful identity query', async () => {
    const test = setup(); const gate = deferred<{ user: { id: string; username: string } }>(); test.me.mockReturnValue(gate.promise);
    test.sockets[0]!.frame({ type: 'event', id: 12, eventType: 'message.created', payload: { message: message() }, createdAt: '', conversationId: 'c' });
    test.sockets[0]!.frame(ready('b'));
    expect(test.state.messages).toEqual({}); expect(test.state.lastEventId).toBeNull();
    test.dispatch({ type: 'user', user: { id: 'c', username: 'Newest' } });
    gate.resolve({ user: { id: 'b', username: 'Old query' } }); await settle();
    expect(test.state.user?.id).toBe('c');
  });
  it('does not log out a new identity when an old identity query later returns 401', async () => {
    const test = setup(); const gate = deferred<{ user: { id: string; username: string } }>(); test.me.mockReturnValue(gate.promise);
    test.sockets[0]!.frame(ready('b'));
    test.dispatch({ type: 'user', user: { id: 'c', username: 'Newest' } });
    gate.reject(new ApiError(401, 'UNAUTHENTICATED', 'old token')); await settle();
    expect(test.state.user?.id).toBe('c'); expect(test.state.connection).toBe('connecting');
  });
  it('retries a current identity refresh after a network failure and recovers', async () => {
    vi.useFakeTimers(); const test = setup(); test.me.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ user: { id: 'b', username: 'New user' } });
    test.sockets[0]!.frame(ready('b')); await settle();
    expect(test.state.connection).toBe('sync_failed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.me).toHaveBeenCalledTimes(2); expect(test.state.user?.id).toBe('b'); expect(test.state.lastEventId).toBeNull();
  });
  it('uses resume(null) when the first snapshot was interrupted and ignores its late completion', async () => {
    vi.useFakeTimers(); const test = setup(); const gate = deferred<void>(); test.snapshot.mockReturnValueOnce(gate.promise);
    test.sockets[0]!.frame(ready()); test.sockets[0]!.disconnect(); await settle();
    await vi.advanceTimersByTimeAsync(1000); test.sockets[1]!.open();
    expect(JSON.parse(test.sockets[1]!.sent[0]!)).toEqual({ type: 'resume', lastEventId: null });
    gate.resolve(); await settle(); expect(test.state.lastEventId).toBeNull();
    test.sockets[1]!.frame(ready('u', 25)); await settle(); expect(test.state.lastEventId).toBe(25);
  });
  it('resumes from an accepted cursor after an ordinary interruption', async () => {
    vi.useFakeTimers(); const test = setup(); test.sockets[0]!.frame(ready()); await settle();
    test.sockets[0]!.disconnect(); await settle(); await vi.advanceTimersByTimeAsync(1000); test.sockets[1]!.open();
    expect(JSON.parse(test.sockets[1]!.sent[0]!)).toEqual({ type: 'resume', lastEventId: 20 }); expect(test.state.user?.id).toBe('u');
  });
  it('clears plans and pending sends on resync and snapshots the current plans page after ready', async () => {
    const test = setup(); test.dispatch({ type: 'page', page: '/plans/p' }); test.dispatch({ type: 'plan', plan: plan() }); test.dispatch({ type: 'pending', conversationId: 'c', message: { clientMessageId: 'x', content: 'old', status: 'sending' } });
    const generation = test.state.generation; test.sockets[0]!.frame({ type: 'resync_required' });
    expect(test.state.generation).toBe(generation + 1); expect(test.state.planDetails).toEqual({}); expect(test.state.pending).toEqual({}); expect(test.snapshot).not.toHaveBeenCalled();
    test.sockets[0]!.frame(ready()); await settle(); expect(test.snapshot).toHaveBeenCalledOnce(); expect(test.state.page).toBe('/plans/p');
  });
  it('reports sync failure and retries without claiming the connection is live', async () => {
    vi.useFakeTimers(); const test = setup(); test.snapshot.mockRejectedValueOnce(new Error('snapshot unavailable')).mockResolvedValueOnce(undefined);
    test.sockets[0]!.frame(ready()); await settle(); expect(test.state.connection).toBe('sync_failed'); expect(test.state.lastEventId).toBeNull();
    await vi.advanceTimersByTimeAsync(1000); expect(test.state.connection).toBe('live'); expect(test.state.lastEventId).toBe(20);
  });
  it.each([4401, 1006])('logs out without reconnecting after revoked authentication (close %s)', async code => {
    vi.useFakeTimers(); const test = setup(); test.me.mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'expired')); test.sockets[0]!.disconnect(code); await settle(); await vi.advanceTimersByTimeAsync(10000);
    expect(test.state.user).toBeNull(); expect(test.sockets).toHaveLength(1);
  });
  it('drops an obsolete close-time authentication probe', async () => {
    const test = setup(); const gate = deferred<{ user: { id: string; username: string } }>(); test.me.mockReturnValue(gate.promise); test.sockets[0]!.disconnect(); test.dispatch({ type: 'user', user: { id: 'b', username: 'New' } }); gate.reject(new ApiError(401, 'UNAUTHENTICATED', 'old')); await settle(); expect(test.state.user?.id).toBe('b');
  });
});
