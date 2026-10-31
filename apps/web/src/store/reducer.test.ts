import { describe, expect, it } from 'vitest';
import { initialState, latestTurn, reducer } from './reducer';
import { conversation, message, plan, turn } from '../test/fixtures';

describe('versioned entity store', () => {
  it('accepts same-version details after a list summary without treating them as duplicates', () => {
    let state = reducer(initialState(), { type: 'summary', conversation: conversation(2) });
    state = reducer(state, { type: 'detail', conversation: conversation(2) });
    expect(state.conversationDetails.c?.data.profile).toEqual(conversation().profile);
    expect(state.conversationDetails.c?.stale).toBe(false);
  });
  it('marks older details stale when a newer summary arrives and clears staleness on matching details', () => {
    let state = reducer(initialState(), { type: 'detail', conversation: conversation(2) });
    state = reducer(state, { type: 'summary', conversation: { ...conversation(3), title: '较新标题' } });
    expect(state.conversationDetails.c?.data.version).toBe(2);
    expect(state.conversationDetails.c?.stale).toBe(true);
    state = reducer(state, { type: 'detail', conversation: conversation(3) });
    expect(state.conversationDetails.c?.stale).toBe(false);
  });
  it('discards an older REST detail after an event has provided a newer detail', () => {
    let state = reducer(initialState(), { type: 'event', event: { type: 'event', id: 8, eventType: 'conversation.upserted', conversationId: 'c', createdAt: '', payload: { conversation: { ...conversation(3), title: '事件的新标题' } } } });
    state = reducer(state, { type: 'detail', conversation: conversation(2) });
    expect(state.conversationDetails.c?.data.title).toBe('事件的新标题');
    expect(state.conversationSummaries.c?.version).toBe(3);
  });
  it('deduplicates, sorts messages and replaces an optimistic message by client identity', () => {
    let state = reducer(initialState(), { type: 'pending', conversationId: 'c', message: { content: '文本', clientMessageId: 'client', status: 'sending' } });
    state = reducer(state, { type: 'message', message: message(3) });
    state = reducer(state, { type: 'message', message: message(1, 'client') });
    state = reducer(state, { type: 'message', message: message(3) });
    expect(state.messages.c?.order).toEqual(['m1', 'm3']);
    expect(state.pending.c).toEqual([]);
  });
  it('keeps plan summaries and plan contents separate', () => {
    let state = reducer(initialState(), { type: 'planSummary', plan: plan() });
    expect(state.planDetails.p).toBeUndefined();
    state = reducer(state, { type: 'plan', plan: plan() });
    state = reducer(state, { type: 'planSummary', plan: { ...plan(), title: '重复摘要' } });
    expect(state.planDetails.p?.content.firstStepId).toBe('passport');
    expect(state.planSummaries.p?.title).toBe('葡萄牙行动计划');
  });
  it('drops old-generation page data and cursor then accepts complete pagination in the new generation', () => {
    let state = reducer(initialState(), { type: 'page', page: '/c/c' });
    const oldScope = { generation: state.generation, page: '/c/c' };
    state = reducer(state, { type: 'messages', conversationId: 'c', items: [message(3), message(4)], nextCursor: 3 });
    state = reducer(state, { type: 'reset' });
    state = reducer(state, { type: 'messages', conversationId: 'c', items: [message(4), message(5)], nextCursor: 4 });
    state = reducer(state, { type: 'messages', conversationId: 'c', items: [message(1), message(2)], nextCursor: null, scope: oldScope });
    expect(state.messages.c?.nextCursor).toBe(4);
    expect(state.messages.c?.order).toEqual(['m4', 'm5']);
    state = reducer(state, { type: 'messages', conversationId: 'c', items: [message(1), message(2), message(3)], nextCursor: null, scope: { generation: state.generation, page: '/c/c' } });
    expect(state.messages.c?.order).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(state.messages.c?.nextCursor).toBeNull();
  });
  it('ignores pagination for a conversation that is no longer being viewed', () => {
    let state = reducer(initialState(), { type: 'page', page: '/c/other' });
    state = reducer(state, { type: 'messages', conversationId: 'c', items: [message()], nextCursor: 1, scope: { generation: 0, page: '/c/c' } });
    expect(state.messages.c).toBeUndefined();
  });
  it('derives activity from accepted turn versions and never erases it using an empty snapshot', () => {
    let state = reducer(initialState(), { type: 'turn', turn: turn(3) });
    state = reducer(state, { type: 'detail', conversation: conversation(1) });
    expect(state.activeTurnByConversation.c).toBe('t');
    state = reducer(state, { type: 'turn', turn: turn(2, 'completed') });
    expect(state.activeTurnByConversation.c).toBe('t');
    state = reducer(state, { type: 'turn', turn: turn(4, 'completed') });
    expect(state.activeTurnByConversation.c).toBeNull();
  });
  it('keeps read positions monotonic and clears all private data on identity change', () => {
    let state = reducer(initialState(), { type: 'read', conversationId: 'c', seq: 8 });
    state = reducer(state, { type: 'read', conversationId: 'c', seq: 2 });
    expect(state.readStates.c).toBe(8);
    state = reducer(state, { type: 'pending', conversationId: 'c', message: { content: 'private', clientMessageId: 'x', status: 'failed' } });
    state = reducer(state, { type: 'plan', plan: plan() });
    state = reducer(state, { type: 'cursor', id: 8 });
    state = reducer(state, { type: 'user', user: { id: 'other', username: 'Other' } });
    expect(state.pending).toEqual({}); expect(state.planDetails).toEqual({}); expect(state.readStates).toEqual({}); expect(state.lastEventId).toBeNull();
  });
  it.each(['retry', 'supplement'])('orders same-millisecond %s by new creation rather than unrelated versions', kind => {
    const old = turn(3, kind === 'retry' ? 'cancelled' : 'superseded');
    let state = reducer(initialState(), { type: 'turn', turn: old });
    const next = { ...turn(1, 'queued'), id: 'next', retryOfTurnId: kind === 'retry' ? old.id : null };
    state = reducer(state, { type: 'turn', turn: next });
    expect(latestTurn(state, 'c')?.id).toBe('next'); expect(state.activeTurnByConversation.c).toBe('next');
    state = reducer(state, { type: 'turn', turn: { ...old, version: 9 }, expectedLatestId: old.id });
    expect(latestTurn(state, 'c')?.id).toBe('next'); expect(state.activeTurnByConversation.c).toBe('next');
    state = reducer(state, { type: 'turn', turn: { ...next, status: 'completed', version: 2 } });
    expect(latestTurn(state, 'c')?.id).toBe('next'); expect(state.activeTurnByConversation.c).toBeNull();
  });
  it('does not revive an obsolete active snapshot after a newer task has already completed', () => {
    let state = reducer(initialState(), { type: 'turn', turn: { ...turn(2, 'completed'), id: 'new' } });
    state = reducer(state, { type: 'turn', turn: turn(), expectedLatestId: null });
    expect(latestTurn(state, 'c')?.id).toBe('new'); expect(state.activeTurnByConversation.c).toBeNull();
  });
});
