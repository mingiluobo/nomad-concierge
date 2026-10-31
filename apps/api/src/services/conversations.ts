import { randomUUID } from 'node:crypto';
import { createEmptyProfile } from '@nomad/shared';
import type { ConversationStatus, CreateConversationRequest, EnginePreference, PostMessageRequest, TurnDto } from '@nomad/shared';
import type { AppDatabase } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { Domain, EventPublisher, TurnService } from '../composition.js';
import { ConversationsRepository } from '../repositories/conversations.js';
import type { ConversationRow } from '../repositories/conversations.js';
import { MessagesRepository } from '../repositories/messages.js';
import { PlansRepository } from '../repositories/plans.js';
import { ReadStatesRepository } from '../repositories/readStates.js';
import { AppError } from '../http/errors.js';
import { conversationDetail, conversationSummary, messageDto, planDto, planSummary } from './dto.js';

export interface TurnQueries {
  get(id: string): { turn: TurnDto } | undefined;
  latest(conversationId: string): TurnDto | null;
}
type Limits = Pick<AppConfig, 'limitMessageChars' | 'limitMessagesPerConversation' | 'limitConversationsPerUser'>;
export class ConversationService {
  private readonly conversations: ConversationsRepository;
  private readonly messages: MessagesRepository;
  private readonly plans: PlansRepository;
  private readonly reads: ReadStatesRepository;
  constructor(private readonly db: AppDatabase, private readonly domain: Domain, private readonly turns: TurnService,
    private readonly publisher: EventPublisher, private readonly turnQueries: TurnQueries, private readonly limits: Limits) {
    this.conversations = new ConversationsRepository(db); this.messages = new MessagesRepository(db);
    this.plans = new PlansRepository(db); this.reads = new ReadStatesRepository(db);
  }
  private owned(userId: string, id: string): ConversationRow {
    const row = this.conversations.get(id);
    if (!row || row.user_id !== userId) throw new AppError('NOT_FOUND', 404, '找不到这个咨询。');
    return row;
  }
  private validateText(input: { content: string; payload?: PostMessageRequest['payload'] }): void {
    if (input.payload?.answers?.length) return;
    if (!input.content.trim()) throw new AppError('VALIDATION_ERROR', 422, '消息不能为空。');
    if (input.content.length > this.limits.limitMessageChars) throw new AppError('MESSAGE_TOO_LONG', 422, '消息超过长度上限。', { limit: this.limits.limitMessageChars });
  }
  private appendConversation(tx: AppDatabase, row: ConversationRow): number {
    return this.publisher.append(tx, { userId: row.user_id, conversationId: row.id, type: 'conversation.upserted', payload: { conversation: conversationDetail(row, this.domain) } });
  }
  private appendTurn(tx: AppDatabase, userId: string, turn: TurnDto): number {
    return this.publisher.append(tx, { userId, conversationId: turn.conversationId, type: 'turn.upserted', payload: { turn } });
  }
  list(userId: string, status?: ConversationStatus) {
    const all = this.conversations.list(userId);
    return { items: all.filter(row => !status || row.status === status).map(conversationSummary), readStates: this.reads.list(userId),
      activeTurns: all.flatMap(row => { const turn = this.turns.activeTurn(row.id); return turn ? [turn] : []; }) };
  }
  detail(userId: string, id: string) {
    const row = this.owned(userId, id);
    const plan = this.plans.forConversation(id);
    return { conversation: conversationDetail(row, this.domain), activeTurn: this.turns.activeTurn(id), latestTurn: this.turnQueries.latest(id),
      plan: plan ? planSummary(planDto(plan, row)) : null, readState: { lastReadSeq: this.reads.get(userId, id) } };
  }
  create(userId: string, input: CreateConversationRequest) {
    const result = this.db.transaction(tx => {
      const existing = this.conversations.byClientId(userId, input.clientMessageId);
      if (existing) return { created: false, conversation: conversationDetail(existing, this.domain),
        message: messageDto(this.messages.byClientId(existing.id, input.clientMessageId)!), turn: this.turnQueries.latest(existing.id)!, eventIds: [] as number[] };
      this.validateText(input);
      if (this.conversations.count(userId) >= this.limits.limitConversationsPerUser) throw new AppError('CONVERSATION_LIMIT_REACHED', 422, '咨询数量已达上限。');
      const id = randomUUID(); const now = new Date().toISOString(); const profile = createEmptyProfile();
      this.conversations.insert(id, userId, this.domain.generateTitle(profile), profile, input.clientMessageId, input.enginePreference ?? 'auto', now);
      const seq = this.conversations.allocateMessage(id, input.content, now);
      const messageId = randomUUID(); this.messages.insert(messageId, id, seq, input.content, input.clientMessageId, undefined, now);
      const { turn } = this.turns.onUserMessage(tx, id, messageId);
      const row = this.conversations.get(id)!; const message = messageDto(this.messages.byClientId(id, input.clientMessageId)!);
      const eventIds = [this.appendConversation(tx, row), this.publisher.append(tx, { userId, conversationId: id, type: 'message.created', payload: { message } }), this.appendTurn(tx, userId, turn)];
      return { created: true, conversation: conversationDetail(row, this.domain), message, turn, eventIds };
    });
    this.publisher.flush(result.eventIds);
    const { eventIds: _eventIds, ...response } = result; void _eventIds; return response;
  }
  setPreference(userId: string, id: string, preference: EnginePreference) {
    const result = this.db.transaction(tx => {
      const row = this.owned(userId, id);
      if (row.status === 'completed') throw new AppError('CONVERSATION_COMPLETED', 409, '这个咨询已生成计划。');
      this.conversations.setPreference(id, preference, new Date().toISOString());
      const updated = this.conversations.get(id)!;
      return { conversation: conversationDetail(updated, this.domain), eventIds: [this.appendConversation(tx, updated)] };
    });
    this.publisher.flush(result.eventIds); return { conversation: result.conversation };
  }
  messagePage(userId: string, id: string, before: number | undefined, limit: number) {
    this.owned(userId, id);
    const rows = this.messages.page(id, before, limit + 1);
    const more = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return { items: page.map(messageDto), nextCursor: more ? page[0]!.seq : null };
  }
  postMessage(userId: string, id: string, input: PostMessageRequest) {
    const result = this.db.transaction(tx => {
      const row = this.owned(userId, id);
      const existing = this.messages.byClientId(id, input.clientMessageId);
      if (existing) return { created: false, message: messageDto(existing), turn: this.turns.activeTurn(id), eventIds: [] as number[] };
      if (row.status === 'completed') throw new AppError('CONVERSATION_COMPLETED', 409, '这个咨询已生成计划，不能再发送消息。');
      if (row.message_count > this.limits.limitMessagesPerConversation - 2) throw new AppError('CONVERSATION_FULL', 422, '已达消息上限，可以生成计划或新建咨询。', { limit: this.limits.limitMessagesPerConversation });
      this.validateText(input);
      const now = new Date().toISOString(); const messageId = randomUUID();
      const seq = this.conversations.allocateMessage(id, input.content, now);
      this.messages.insert(messageId, id, seq, input.content, input.clientMessageId, input.payload, now);
      const { turn, superseded } = this.turns.onUserMessage(tx, id, messageId);
      const message = messageDto(this.messages.byClientId(id, input.clientMessageId)!);
      const eventIds = [this.publisher.append(tx, { userId, conversationId: id, type: 'message.created', payload: { message } }),
        ...(superseded ? [this.appendTurn(tx, userId, superseded)] : []), this.appendTurn(tx, userId, turn), this.appendConversation(tx, this.conversations.get(id)!)];
      return { created: true, message, turn, eventIds };
    });
    this.publisher.flush(result.eventIds);
    const { eventIds: _eventIds, ...response } = result; void _eventIds; return response;
  }
  private ownedTurn(userId: string, id: string, turnId: string): void {
    this.owned(userId, id);
    if (this.turnQueries.get(turnId)?.turn.conversationId !== id) throw new AppError('NOT_FOUND', 404, '找不到这一轮回复。');
  }
  cancel(userId: string, id: string, turnId: string) { this.ownedTurn(userId, id, turnId); return { turn: this.turns.cancel(id, turnId) }; }
  retry(userId: string, id: string, turnId: string) { this.ownedTurn(userId, id, turnId); return this.turns.retry(id, turnId); }
  markRead(userId: string, id: string, seq: number) {
    const result = this.db.transaction(tx => {
      const row = this.owned(userId, id); const previous = this.reads.get(userId, id);
      const accepted = Math.max(previous, Math.min(seq, row.last_seq));
      if (accepted === previous) return { lastReadSeq: previous, eventIds: [] as number[] };
      const lastReadSeq = this.reads.update(userId, id, accepted, new Date().toISOString());
      return { lastReadSeq, eventIds: [this.publisher.append(tx, { userId, conversationId: id, type: 'read_state.updated', payload: { conversationId: id, lastReadSeq } })] };
    });
    this.publisher.flush(result.eventIds); return { lastReadSeq: result.lastReadSeq };
  }
  private assertGeneratable(row: ConversationRow, allowIncomplete: boolean): ReturnType<Domain['progress']> {
    if (this.turns.activeTurn(row.id)) throw new AppError('TURN_IN_PROGRESS', 409, '正在回复，请稍候。');
    const count = this.messages.unprocessedCount(row.id);
    if (count) throw new AppError('UNPROCESSED_MESSAGES', 409, '还有消息没处理完，请先重试这一轮。', { count });
    const detail = conversationDetail(row, this.domain);
    if (!detail.progress.canGenerateEarly) throw new AppError('PROFILE_INSUFFICIENT', 422, '还需要目的国、诉求和本人国籍。', {
      missing: (['destination', 'goals', 'applicantNationality'] as const).filter(slot => detail.profile.slots[slot].status !== 'known'),
    });
    if (!detail.progress.isComplete && !allowIncomplete) throw new AppError('PROFILE_INCOMPLETE', 409, '信息不完整，请先确认提前生成。', { missing: detail.progress.missing });
    return detail.progress;
  }
  generatePlan(userId: string, id: string, allowIncomplete = false) {
    const initial = this.owned(userId, id);
    const existing = this.plans.forConversation(id);
    if (existing) return { created: false, plan: planDto(existing, initial) };
    const progress = this.assertGeneratable(initial, allowIncomplete);
    const now = new Date().toISOString();
    const prepared = this.domain.generatePlan(conversationDetail(initial, this.domain).profile, now, !progress.isComplete);
    const result = this.db.transaction(tx => {
      const row = this.owned(userId, id); const existing = this.plans.forConversation(id);
      if (existing) return { created: false, plan: planDto(existing, row), eventIds: [] as number[] };
      const currentProgress = this.assertGeneratable(row, allowIncomplete);
      const content = row.version === initial.version ? prepared : this.domain.generatePlan(conversationDetail(row, this.domain).profile, now, !currentProgress.isComplete);
      const planId = randomUUID();
      if (!this.conversations.complete(id, planId, now)) throw new AppError('CONVERSATION_COMPLETED', 409, '这个咨询已生成计划。');
      this.plans.insert(planId, id, userId, content, now);
      const updated = this.conversations.get(id)!; const plan = planDto(this.plans.get(planId)!, updated);
      const eventIds = [this.publisher.append(tx, { userId, conversationId: id, type: 'plan.created', payload: { plan: planSummary(plan) } }), this.appendConversation(tx, updated)];
      return { created: true, plan, eventIds };
    });
    this.publisher.flush(result.eventIds); return { created: result.created, plan: result.plan };
  }
  listPlans(userId: string) { return { items: this.plans.list(userId).map(row => planSummary(planDto(row, this.owned(userId, row.conversation_id)))) }; }
  getPlan(userId: string, id: string) {
    const row = this.plans.get(id);
    if (!row || row.user_id !== userId) throw new AppError('NOT_FOUND', 404, '找不到这个计划。');
    return { plan: planDto(row, this.owned(userId, row.conversation_id)) };
  }
}
