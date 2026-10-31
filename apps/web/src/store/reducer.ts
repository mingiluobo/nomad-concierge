import type { BusinessEvent, ConversationDetailDto, ConversationSummaryDto, EngineStatus, MessageDto, PlanDto, PlanSummaryDto, RuntimeLimits, TurnDto, UserDto, UserPayload } from '@nomad/shared';

export type Connection = 'connecting' | 'syncing' | 'sync_failed' | 'live' | 'reconnecting' | 'offline';
export interface PendingMessage { clientMessageId: string; content: string; payload?: UserPayload; status: 'sending' | 'failed'; error?: string }
export interface MessagePage { byId: Record<string, MessageDto>; order: string[]; nextCursor: number | null; loadingOlder: boolean }
export interface Scope { generation: number; page?: string }
export interface AppState {
  limits: RuntimeLimits;
  user: UserDto | null; booting: boolean; generation: number; page: string;
  connection: Connection; lastEventId: number | null; engines: EngineStatus[];
  conversationSummaries: Record<string, ConversationSummaryDto>;
  conversationDetails: Record<string, { data: ConversationDetailDto; stale: boolean }>;
  readStates: Record<string, number>; messages: Record<string, MessagePage>; pending: Record<string, PendingMessage[]>;
  turns: Record<string, TurnDto>; activeTurnByConversation: Record<string, string | null>;
  latestTurnByConversation: Record<string, string>;
  planSummaries: Record<string, PlanSummaryDto>; planDetails: Record<string, PlanDto>;
  loadedPages: Record<string, boolean>; pageError: string | null;
}
export function initialState(): AppState {
  return { limits: { messageChars: 2000, messagesPerConversation: 200 }, user: null, booting: true, generation: 0, page: '/', connection: 'offline', lastEventId: null, engines: [], conversationSummaries: {}, conversationDetails: {}, readStates: {}, messages: {}, pending: {}, turns: {}, activeTurnByConversation: {}, latestTurnByConversation: {}, planSummaries: {}, planDetails: {}, loadedPages: {}, pageError: null };
}
export type Action = (
  | { type: 'user'; user: UserDto | null; limits?: RuntimeLimits }
  | { type: 'limits'; limits?: RuntimeLimits }
  | { type: 'page'; page: string }
  | { type: 'reset' }
  | { type: 'connection'; connection: Connection }
  | { type: 'cursor'; id: number }
  | { type: 'engines'; engines: EngineStatus[] }
  | { type: 'summary'; conversation: ConversationSummaryDto }
  | { type: 'detail'; conversation: ConversationDetailDto }
  | { type: 'turn'; turn: TurnDto; expectedLatestId?: string | null }
  | { type: 'message'; message: MessageDto }
  | { type: 'messages'; conversationId: string; items: MessageDto[]; nextCursor: number | null }
  | { type: 'loadingOlder'; conversationId: string; loading: boolean }
  | { type: 'pending'; conversationId: string; message: PendingMessage }
  | { type: 'clearPending'; conversationId: string; clientMessageId: string }
  | { type: 'read'; conversationId: string; seq: number }
  | { type: 'planSummary'; plan: PlanSummaryDto }
  | { type: 'plan'; plan: PlanDto }
  | { type: 'loaded'; page: string }
  | { type: 'pageError'; error: string | null }
  | { type: 'event'; event: BusinessEvent }
) & { scope?: Scope };
export const emptyMessages = (): MessagePage => ({ byId: {}, order: [], nextCursor: null, loadingOlder: false });
export function scopeMatches(state: AppState, scope?: Scope): boolean {
  return !scope || (scope.generation === state.generation && (scope.page === undefined || scope.page === state.page));
}
function summary(state: AppState, conversation: ConversationSummaryDto): AppState {
  const current = state.conversationSummaries[conversation.id];
  if (current && current.version >= conversation.version) return state;
  const detail = state.conversationDetails[conversation.id];
  return { ...state, conversationSummaries: { ...state.conversationSummaries, [conversation.id]: conversation }, conversationDetails: detail && detail.data.version < conversation.version ? { ...state.conversationDetails, [conversation.id]: { ...detail, stale: true } } : state.conversationDetails };
}
function mergeMessage(state: AppState, message: MessageDto): AppState {
  const page = state.messages[message.conversationId] ?? emptyMessages();
  const byId = { ...page.byId, [message.id]: message };
  return { ...state, messages: { ...state.messages, [message.conversationId]: { ...page, byId, order: Object.values(byId).sort((a, b) => a.seq - b.seq).map(item => item.id) } }, pending: { ...state.pending, [message.conversationId]: (state.pending[message.conversationId] ?? []).filter(item => !message.clientMessageId || item.clientMessageId !== message.clientMessageId) } };
}
export function reducer(state: AppState, action: Action): AppState {
  if (!scopeMatches(state, action.scope)) return state;
  switch (action.type) {
    case 'user': return { ...initialState(), limits: action.limits ?? initialState().limits, user: action.user, booting: false, generation: state.generation + 1, page: state.page, connection: action.user ? 'connecting' : 'offline' };
    case 'limits': return { ...state, limits: action.limits ?? initialState().limits };
    case 'reset': return { ...initialState(), limits: state.limits, user: state.user, booting: false, generation: state.generation + 1, page: state.page, connection: 'syncing' };
    case 'page': return { ...state, page: action.page, pageError: null };
    case 'connection': return { ...state, connection: action.connection };
    case 'cursor': return { ...state, lastEventId: Math.max(state.lastEventId ?? 0, action.id) };
    case 'engines': return { ...state, engines: action.engines };
    case 'summary': return summary(state, action.conversation);
    case 'detail': {
      const next = summary(state, action.conversation);
      const existing = next.conversationDetails[action.conversation.id];
      if (existing && existing.data.version >= action.conversation.version) return next;
      return { ...next, conversationDetails: { ...next.conversationDetails, [action.conversation.id]: { data: action.conversation, stale: (next.conversationSummaries[action.conversation.id]?.version ?? 0) > action.conversation.version } } };
    }
    case 'turn': {
      const previous = state.turns[action.turn.id];
      const turns = previous && previous.version >= action.turn.version ? state.turns : { ...state.turns, [action.turn.id]: action.turn };
      const incoming = turns[action.turn.id]!;
      const currentId = state.latestTurnByConversation[incoming.conversationId];
      const current = currentId ? turns[currentId] : undefined;
      const unchangedSinceRequest = action.expectedLatestId === undefined || action.expectedLatestId === (currentId ?? null);
      const sameTime = current && incoming.createdAt === current.createdAt;
      const newCreation = !previous && ['queued', 'running'].includes(incoming.status);
      const replace = !current || incoming.createdAt > current.createdAt || (sameTime && unchangedSinceRequest && (action.expectedLatestId !== undefined || incoming.retryOfTurnId === current.id || newCreation));
      const latestId = replace ? incoming.id : currentId!;
      const latest = turns[latestId]!;
      return { ...state, turns, latestTurnByConversation: { ...state.latestTurnByConversation, [incoming.conversationId]: latestId }, activeTurnByConversation: { ...state.activeTurnByConversation, [incoming.conversationId]: ['queued', 'running'].includes(latest.status) ? latest.id : null } };
    }
    case 'message': return mergeMessage(state, action.message);
    case 'messages': {
      const merged = action.items.reduce(mergeMessage, state);
      const page = merged.messages[action.conversationId] ?? emptyMessages();
      return { ...merged, messages: { ...merged.messages, [action.conversationId]: { ...page, nextCursor: action.nextCursor, loadingOlder: false } } };
    }
    case 'loadingOlder': return { ...state, messages: { ...state.messages, [action.conversationId]: { ...(state.messages[action.conversationId] ?? emptyMessages()), loadingOlder: action.loading } } };
    case 'pending': return { ...state, pending: { ...state.pending, [action.conversationId]: [...(state.pending[action.conversationId] ?? []).filter(item => item.clientMessageId !== action.message.clientMessageId), action.message] } };
    case 'clearPending': return { ...state, pending: { ...state.pending, [action.conversationId]: (state.pending[action.conversationId] ?? []).filter(item => item.clientMessageId !== action.clientMessageId) } };
    case 'read': return { ...state, readStates: { ...state.readStates, [action.conversationId]: Math.max(state.readStates[action.conversationId] ?? 0, action.seq) } };
    case 'planSummary': return state.planSummaries[action.plan.id] ? state : { ...state, planSummaries: { ...state.planSummaries, [action.plan.id]: action.plan } };
    case 'plan': return { ...state, planSummaries: { ...state.planSummaries, [action.plan.id]: action.plan }, planDetails: { ...state.planDetails, [action.plan.id]: action.plan } };
    case 'loaded': return { ...state, loadedPages: { ...state.loadedPages, [action.page]: true }, pageError: null };
    case 'pageError': return { ...state, pageError: action.error };
    case 'event': {
      const event = action.event;
      let next = state;
      switch (event.eventType) {
        case 'conversation.upserted': next = reducer(state, { type: 'detail', conversation: event.payload.conversation }); break;
        case 'message.created': next = reducer(state, { type: 'message', message: event.payload.message }); break;
        case 'turn.upserted': next = reducer(state, { type: 'turn', turn: event.payload.turn }); break;
        case 'plan.created': next = reducer(state, { type: 'planSummary', plan: event.payload.plan }); break;
        case 'read_state.updated': next = reducer(state, { type: 'read', conversationId: event.payload.conversationId, seq: event.payload.lastReadSeq }); break;
      }
      return { ...next, lastEventId: Math.max(next.lastEventId ?? 0, event.id) };
    }
  }
}
export const unreadCount = (state: AppState) => Object.values(state.conversationSummaries).filter(item => item.lastAssistantSeq > (state.readStates[item.id] ?? 0)).length;
export const latestTurn = (state: AppState, conversationId: string) => state.turns[state.latestTurnByConversation[conversationId] ?? ''];
