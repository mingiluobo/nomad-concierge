import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProfile } from '@nomad/shared';
import { AppDatabase } from '../../src/db/database.js';
import { TurnsRepository } from '../../src/repositories/turns.js';
import { EventsRepository } from '../../src/repositories/events.js';
import { PersistentEventPublisher } from '../../src/realtime/publisher.js';
import { TurnRunner } from '../../src/turns/runner.js';
import { recoverRunningTurns } from '../../src/turns/recovery.js';
import { createShutdown } from '../../src/lifecycle/shutdown.js';
import { controlledInterpreter, createHarness, fakeDomain, result, socketHarness } from '../helpers/wp4.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); while (cleanups.length) await cleanups.pop()!(); });
const setup = (options?: Parameters<typeof createHarness>[0]) => { const h = createHarness(options); cleanups.push(h.close); return h; };
function assistantCount(h: ReturnType<typeof createHarness>, id: string) { return h.database.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'assistant'").get<{ n: number }>(id)!.n; }

describe('turn execution and transactional persistence', () => {
  it.each(['superseded', 'cancelled', 'timeout'] as const)('rejects an interpreter that returns late after %s at the commit guard', async outcome => {
    const controlled = controlledInterpreter();
    const h = setup({ interpreter: controlled.interpreter, timeoutMs: outcome === 'timeout' ? 50 : 3000, concurrency: 1 });
    const conversationId = h.conversation();
    const first = h.send(conversationId, 'first input');
    const complete = vi.spyOn(h.turns, 'complete');
    h.runner.start();
    await vi.waitFor(() => expect(controlled.calls).toHaveLength(1));
    let replacement: ReturnType<typeof h.send> | undefined;
    if (outcome === 'superseded') replacement = h.send(conversationId, 'second input');
    else if (outcome === 'cancelled') h.service.cancel(conversationId, first.turn.id);
    else await vi.waitFor(() => expect(h.turns.get(first.turn.id)?.turn.errorCode).toBe('TURN_TIMEOUT'));
    expect(controlled.calls[0]!.signal.aborted).toBe(true);
    controlled.calls[0]!.release(result({ updates: [{ slot: 'destination', value: 'PT' }] }));
    await vi.waitFor(() => expect(complete.mock.calls.some(call => call[1].id === first.turn.id)).toBe(true));
    expect(assistantCount(h, conversationId)).toBe(0);
    expect(h.turns.conversation(conversationId)!.conversation.profile.slots.destination).toEqual({ status: 'missing' });
    expect(h.database.prepare('SELECT consumed_by_turn_id FROM messages WHERE id = ?').get(first.messageId)).toEqual({ consumed_by_turn_id: null });
    const successEvents = h.database.prepare("SELECT payload_json FROM events WHERE type = 'turn.upserted'").all<{ payload_json: string }>()
      .map(row => JSON.parse(row.payload_json).turn).filter(turn => turn.id === first.turn.id && turn.status === 'completed');
    expect(successEvents).toEqual([]);
    expect(h.turns.get(first.turn.id)?.turn.status).toBe(outcome === 'timeout' ? 'failed' : outcome);
    if (replacement) {
      await vi.waitFor(() => expect(controlled.calls).toHaveLength(2));
      expect(controlled.calls[1]!.input.newMessages.map(message => message.id)).toEqual([first.messageId, replacement.messageId]);
      controlled.calls[1]!.release(result({ updates: [{ slot: 'destination', value: 'CL' }] }));
      await h.runner.settled();
      expect(assistantCount(h, conversationId)).toBe(1);
      expect(h.turns.conversation(conversationId)!.conversation.profile.slots.destination.value).toBe('CL');
      expect(h.database.prepare("SELECT DISTINCT consumed_by_turn_id FROM messages WHERE role = 'user'").all()).toEqual([{ consumed_by_turn_id: replacement.turn.id }]);
    } else await h.runner.settled();
  });

  it('only updates the selected slot for quick answers and reports no interpreter engine', async () => {
    const interpret = vi.fn(async () => result());
    const h = setup({ interpreter: { id: 'rules', interpret } });
    const forPreference = vi.spyOn(h.interpreters, 'forPreference');
    const profile = createEmptyProfile(); profile.pendingSlots = ['applicantNationality', 'partnerNationality'];
    const id = h.conversation(profile);
    const sent = h.send(id, '中国', { answers: [{ slot: 'partnerNationality', value: 'CN', label: '中国' }] });
    h.runner.start(); await h.runner.settled();
    expect(interpret).not.toHaveBeenCalled();
    expect(forPreference).not.toHaveBeenCalled();
    const saved = h.turns.conversation(id)!.conversation.profile;
    expect(saved.slots.partnerNationality).toMatchObject({ status: 'known', value: 'CN', sourceMessageId: sent.messageId });
    expect(saved.slots.applicantNationality).toEqual({ status: 'missing' });
    const payload = JSON.parse(h.database.prepare("SELECT payload_json FROM messages WHERE role = 'assistant'").get<{ payload_json: string }>()!.payload_json);
    expect(payload.process.engineUsed).toBeNull();
    expect(h.turns.get(sent.turn.id)?.turn).toMatchObject({ status: 'completed', engineUsed: null, version: 5 });
    const secondId = h.conversation(profile);
    h.send(secondId, '不确定', { answers: [{ slot: 'partnerNationality', value: { unsure: true }, label: '不确定' }] });
    await h.runner.settled();
    expect(h.turns.conversation(secondId)!.conversation.profile.slots.partnerNationality.status).toBe('unsure');
    expect(h.turns.conversation(secondId)!.conversation.profile.slots.applicantNationality.status).toBe('missing');
    expect(interpret).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves text/quick-answer order and the final source message (reversed=%s)', async reversed => {
    const controlled = controlledInterpreter(); const domain = fakeDomain(); const reconcile = vi.spyOn(domain, 'reconcile');
    const h = setup({ interpreter: controlled.interpreter, domain });
    const profile = createEmptyProfile(); profile.slots.applicantNationality = { status: 'known', value: 'PT' };
    const id = h.conversation(profile);
    const quick = () => h.send(id, '同本人国籍', { answers: [{ slot: 'partnerNationality', value: 'PT', label: '同本人国籍' }] });
    const text = () => h.send(id, '配偶是中国籍');
    const a = reversed ? quick() : text(); const b = reversed ? text() : quick(); const c = h.send(id, '计划时间是明年');
    h.runner.start(); await vi.waitFor(() => expect(controlled.calls).toHaveLength(1));
    if (reversed) {
      expect(controlled.calls[0]!.input.newMessages.map(message => message.id)).toEqual([b.messageId, c.messageId]);
      expect(controlled.calls[0]!.input.profile.slots.partnerNationality.value).toBe('PT');
      controlled.calls[0]!.release(result({ updates: [{ slot: 'partnerNationality', value: 'CN' }, { slot: 'timeline', value: '6to12m' }] }));
    } else {
      controlled.calls[0]!.release({ ...result({ updates: [{ slot: 'partnerNationality', value: 'CN' }] }), engineUsed: 'remote' });
      await vi.waitFor(() => expect(controlled.calls).toHaveLength(2));
      expect(controlled.calls[1]!.input.profile.slots.partnerNationality.value).toBe('PT');
      controlled.calls[1]!.release({ ...result({ updates: [{ slot: 'timeline', value: '6to12m' }] }), fallbacks: [{ engine: 'remote', reason: 'invalid_output' }] });
    }
    await h.runner.settled();
    const saved = h.turns.conversation(id)!.conversation.profile;
    expect(saved.slots.partnerNationality).toMatchObject({ value: reversed ? 'CN' : 'PT', sourceMessageId: reversed ? c.messageId : b.messageId });
    expect(saved.slots.timeline).toMatchObject({ value: '6to12m', sourceMessageId: c.messageId });
    expect(reconcile.mock.calls[0]![2]).toEqual(['partnerNationality', 'timeline']);
    expect(assistantCount(h, id)).toBe(1);
    expect(h.turns.get(c.turn.id)?.turn.engineUsed).toBe('rules');
    expect(h.database.prepare('SELECT id FROM messages WHERE consumed_by_turn_id = ? ORDER BY seq').all(c.turn.id)).toEqual([{ id: a.messageId }, { id: b.messageId }, { id: c.messageId }]);
  });

  it('passes explicit same-value slots from all segments to reconciliation', async () => {
    const domain = fakeDomain(); const reconcile = vi.spyOn(domain, 'reconcile');
    const h = setup({ domain });
    const p = createEmptyProfile(); p.slots.currentResidence = { status: 'known', value: 'CN' }; p.slots.residenceStatus = { status: 'known', value: 'citizen' };
    const id = h.conversation(p);
    h.send(id, '葡萄牙', { answers: [{ slot: 'currentResidence', value: 'PT', label: '葡萄牙' }] });
    h.send(id, '公民', { answers: [{ slot: 'residenceStatus', value: 'citizen', label: '公民' }] });
    h.runner.start(); await h.runner.settled();
    expect(reconcile.mock.calls[0]![2]).toEqual(['currentResidence', 'residenceStatus']);
  });

  it('uses one total deadline across multiple text segments', async () => {
    vi.useFakeTimers();
    const controlled = controlledInterpreter(); const h = setup({ interpreter: controlled.interpreter, timeoutMs: 80 });
    const id = h.conversation(); h.send(id, 'first'); h.send(id, '中国', { answers: [{ slot: 'applicantNationality', value: 'CN', label: '中国' }] }); const last = h.send(id, 'last');
    h.runner.start();
    await vi.advanceTimersByTimeAsync(50); controlled.calls[0]!.release(result());
    await vi.advanceTimersByTimeAsync(0); expect(controlled.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(31);
    expect(h.turns.get(last.turn.id)?.turn).toMatchObject({ status: 'failed', errorCode: 'TURN_TIMEOUT' });
    controlled.calls[1]!.release(result()); await h.runner.settled();
    expect(assistantCount(h, id)).toBe(0);
  });

  it('makes cancel idempotent, only retries the latest ended task, and checks the conversation', async () => {
    const h = setup(); const id = h.conversation(); const other = h.conversation(); const first = h.send(id, 'hello');
    expect(() => h.service.cancel(other, first.turn.id)).toThrow('找不到');
    expect(() => h.service.retry(other, first.turn.id)).toThrow('找不到');
    const cancelled = h.service.cancel(id, first.turn.id);
    expect(h.service.cancel(id, first.turn.id)).toEqual(cancelled);
    const retried = h.service.retry(id, first.turn.id);
    expect(retried.created).toBe(true); expect(retried.turn.retryOfTurnId).toBe(first.turn.id);
    expect(h.service.retry(id, first.turn.id)).toEqual({ turn: retried.turn, created: false });
    h.service.cancel(id, retried.turn.id);
    expect(() => h.service.retry(id, first.turn.id)).toThrow('最新');
    h.runner.start(); const final = h.service.retry(id, retried.turn.id); await h.runner.settled();
    expect(h.turns.get(final.turn.id)?.turn.status).toBe('completed'); expect(assistantCount(h, id)).toBe(1);
    expect(() => h.service.retry(id, final.turn.id)).toThrow('最新');
  });

  it('rolls back a reply transaction before commit without emitting its events', async () => {
    const controlled = controlledInterpreter(); const h = setup({ interpreter: controlled.interpreter });
    const sockets = await socketHarness(h); cleanups.push(sockets.close);
    const client = await sockets.connect(); client.socket.send(JSON.stringify({ type: 'resume', lastEventId: null }));
    await vi.waitFor(() => expect(client.messages.some(message => message.type === 'ready')).toBe(true));
    const id = h.conversation(); const sent = h.send(id, '葡萄牙'); h.runner.start();
    let failed = false;
    h.inject(() => {
      if (h.turns.get(sent.turn.id)?.turn.status === 'completed') { failed = true; h.inject(); throw new Error('beforeCommit failure'); }
    });
    controlled.calls[0]!.release(result({ updates: [{ slot: 'destination', value: 'PT' }] }));
    await h.runner.settled();
    expect(failed).toBe(true); expect(h.errors).toHaveLength(1);
    expect(h.turns.get(sent.turn.id)?.turn).toMatchObject({ status: 'failed', errorCode: 'INTERNAL_ERROR' });
    expect(assistantCount(h, id)).toBe(0);
    expect(h.turns.conversation(id)!.conversation.profile.slots.destination.status).toBe('missing');
    expect(h.database.prepare('SELECT consumed_by_turn_id FROM messages WHERE id = ?').get(sent.messageId)).toEqual({ consumed_by_turn_id: null });
    const pong = once(client.socket, 'pong'); client.socket.ping(); await pong;
    expect(client.messages.filter(message => message.type === 'event' && (message.eventType === 'message.created' || message.eventType === 'conversation.upserted' || (message.eventType === 'turn.upserted' && message.payload.turn.status === 'completed')))).toEqual([]);
  });

  it('restores a running task from a reopened file database with the same id and increased attempt', async () => {
    const h = setup(); const id = h.conversation(); const first = h.send(id, 'hello');
    h.database.transaction(tx => h.turns.transition(tx, first.turn.id, 'queued', 'running', new Date().toISOString()));
    h.database.close(); h.markClosed();
    const database = new AppDatabase(h.databasePath); const domain = fakeDomain();
    const turns = new TurnsRepository(database, domain, (from, to) => ({ setSql: 'status = ?, version = version + 1', setParameters: [to], whereSql: 'status IN (?)', whereParameters: [from] }));
    const publisher = new PersistentEventPublisher(new EventsRepository(database));
    const runner = new TurnRunner(database, turns, publisher, domain, { forPreference: () => ({ id: 'rules', interpret: async () => result() }), status: () => [] }, { turnConcurrency: 1, turnTimeoutMs: 2000, demoDelayMs: 0, llmRecentMessages: 6 });
    runner.start(); await runner.settled();
    expect(turns.get(first.turn.id)?.turn).toMatchObject({ id: first.turn.id, attempt: 2, status: 'completed' });
    expect(database.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant'").get()).toEqual({ n: 1 });
    runner.dispose(); database.close();
  });

  it('ends recovery after the third attempt and keeps graceful shutdown separate', async () => {
    const h = setup(); const id = h.conversation(); const sent = h.send(id, 'hello');
    h.database.prepare("UPDATE turns SET status = 'running', attempt = 3 WHERE id = ?").run(sent.turn.id);
    recoverRunningTurns(h.database, h.turns, h.publisher);
    expect(h.turns.get(sent.turn.id)?.turn).toMatchObject({ attempt: 4, status: 'failed', errorCode: 'RECOVERY_LIMIT' });
    expect(assistantCount(h, id)).toBe(0);
  });

  it('gracefully queues running work, closes sockets with 1012 and ignores a late result after DB close', async () => {
    const controlled = controlledInterpreter(); const h = setup({ interpreter: controlled.interpreter });
    const sockets = await socketHarness(h); const client = await sockets.connect();
    const id = h.conversation(); const sent = h.send(id, 'hello'); h.runner.start();
    const close = once(client.socket, 'close');
    const shutdown = createShutdown({ server: sockets.server, realtime: sockets.realtime, runner: h.runner, database: h.database, forceExit: () => { throw new Error('unexpected shutdown deadline'); } });
    await shutdown(); h.markClosed();
    expect((await close)[0]).toBe(1012); expect(controlled.calls[0]!.signal.aborted).toBe(true);
    const reopened = new AppDatabase(h.databasePath);
    expect(reopened.prepare('SELECT status, attempt FROM turns WHERE id = ?').get(sent.turn.id)).toEqual({ status: 'queued', attempt: 1 });
    reopened.close();
    controlled.calls[0]!.release(result({ updates: [{ slot: 'destination', value: 'PT' }] }));
    await h.runner.settled(); expect(h.errors).toEqual([]);
  });

  it('enforces the concurrency limit and claims queued work as a slot becomes available', async () => {
    const controlled = controlledInterpreter(); const h = setup({ interpreter: controlled.interpreter, concurrency: 2 });
    for (let i = 0; i < 3; i += 1) h.send(h.conversation(), 'hello');
    h.runner.start(); expect(controlled.calls).toHaveLength(2); expect(h.runner.activeCount()).toBe(2);
    controlled.calls[0]!.release(result()); await vi.waitFor(() => expect(controlled.calls).toHaveLength(3));
    expect(h.runner.activeCount()).toBe(2);
    controlled.calls[1]!.release(result()); controlled.calls[2]!.release(result()); await h.runner.settled();
    expect(h.database.prepare("SELECT COUNT(*) AS n FROM turns WHERE status = 'completed'").get()).toEqual({ n: 3 });
  });
});
