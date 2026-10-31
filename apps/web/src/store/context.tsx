import { createContext, useCallback, useContext, useEffect, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError, errorText } from '../api/client';
import { RealtimeClient } from '../realtime/socket';
import { initialState, reducer, scopeMatches } from './reducer';
import type { Action, AppState, Scope } from './reducer';

interface Store {
  state: AppState; dispatch(action: Action): void; getState(): AppState;
  scope(page?: boolean): Scope; isCurrent(scope: Scope): boolean;
  loadPage(): Promise<void>; refreshConversation(id: string): Promise<void>; handleError(error: unknown): string;
  retrySession(): Promise<void>;
}
const Context = createContext<Store | null>(null);
export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, reactDispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef(state);
  const location = useLocation();
  const dispatch = useCallback((action: Action) => { stateRef.current = reducer(stateRef.current, action); reactDispatch(action); }, []);
  const getState = useCallback(() => stateRef.current, []);
  const scope = useCallback((page = false): Scope => ({ generation: stateRef.current.generation, ...(page ? { page: stateRef.current.page } : {}) }), []);
  const isCurrent = useCallback((value: Scope) => scopeMatches(stateRef.current, value), []);
  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) dispatch({ type: 'user', user: null });
    return errorText(error);
  }, [dispatch]);
  const retrySession = useCallback(async () => {
    const token = scope();
    try { const { user, limits } = await api.me(); if (isCurrent(token)) dispatch({ type: 'user', user, limits }); }
    catch (error) {
      if (!isCurrent(token)) return;
      if (error instanceof ApiError && error.status === 401) dispatch({ type: 'user', user: null });
      else dispatch({ type: 'pageError', error: errorText(error), scope: token });
    }
  }, [dispatch, scope, isCurrent]);
  const refreshConversation = useCallback(async (id: string) => {
    const token = scope(true);
    const expectedLatestId = stateRef.current.latestTurnByConversation[id] ?? null;
    const result = await api.conversation(id);
    dispatch({ type: 'detail', conversation: result.conversation, scope: token });
    if (result.activeTurn) dispatch({ type: 'turn', turn: result.activeTurn, expectedLatestId, scope: token });
    if (result.latestTurn) dispatch({ type: 'turn', turn: result.latestTurn, expectedLatestId, scope: token });
    if (result.plan) dispatch({ type: 'planSummary', plan: result.plan, scope: token });
    dispatch({ type: 'read', conversationId: id, seq: result.readState.lastReadSeq, scope: token });
  }, [dispatch, scope]);
  const loadPage = useCallback(async () => {
    const token = scope(true);
    const page = stateRef.current.page;
    const pathname = page.split('?')[0] ?? '/';
    const turnHeads = { ...stateRef.current.latestTurnByConversation };
    dispatch({ type: 'pageError', error: null, scope: token });
    try {
      const [list, engines] = await Promise.all([api.conversations(), api.engines()]);
      for (const conversation of list.items) dispatch({ type: 'summary', conversation, scope: token });
      for (const turn of list.activeTurns) dispatch({ type: 'turn', turn, expectedLatestId: turnHeads[turn.conversationId] ?? null, scope: token });
      for (const read of list.readStates) dispatch({ type: 'read', conversationId: read.conversationId, seq: read.lastReadSeq, scope: token });
      dispatch({ type: 'engines', engines: engines.engines, scope: token });
      if (!isCurrent(token)) return;
      if (pathname.startsWith('/c/')) {
        const id = decodeURIComponent(pathname.slice(3));
        const expectedLatestId = stateRef.current.latestTurnByConversation[id] ?? null;
        const [result, messages] = await Promise.all([api.conversation(id), api.messages(id)]);
        dispatch({ type: 'detail', conversation: result.conversation, scope: token });
        if (result.activeTurn) dispatch({ type: 'turn', turn: result.activeTurn, expectedLatestId, scope: token });
        if (result.latestTurn) dispatch({ type: 'turn', turn: result.latestTurn, expectedLatestId, scope: token });
        if (result.plan) dispatch({ type: 'planSummary', plan: result.plan, scope: token });
        dispatch({ type: 'read', conversationId: id, seq: result.readState.lastReadSeq, scope: token });
        dispatch({ type: 'messages', conversationId: id, ...messages, scope: token });
      } else if (pathname === '/plans') {
        const result = await api.plans();
        for (const plan of result.items) dispatch({ type: 'planSummary', plan, scope: token });
      } else if (pathname.startsWith('/plans/')) {
        const result = await api.plan(decodeURIComponent(pathname.slice(7)));
        dispatch({ type: 'plan', plan: result.plan, scope: token });
      }
      dispatch({ type: 'loaded', page, scope: token });
    } catch (error) {
      if (!isCurrent(token)) return;
      dispatch({ type: 'pageError', error: error instanceof ApiError && error.status === 404 ? '找不到这个咨询或计划。' : handleError(error), scope: token });
      throw error;
    }
  }, [dispatch, scope, isCurrent, handleError]);
  useEffect(() => {
    let active = true;
    void api.me().then(({ user, limits }) => { if (active) dispatch({ type: 'user', user, limits }); }).catch(error => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) dispatch({ type: 'user', user: null });
      else { dispatch({ type: 'user', user: null }); dispatch({ type: 'pageError', error: errorText(error) }); }
    });
    return () => { active = false; };
  }, [dispatch]);
  useEffect(() => {
    const page = location.pathname + location.search;
    dispatch({ type: 'page', page });
    if (stateRef.current.user && stateRef.current.connection === 'live') void loadPage().catch(() => undefined);
  }, [location.pathname, location.search, dispatch, loadPage]);
  useEffect(() => {
    if (!state.user) return;
    const client = new RealtimeClient({
      getState, dispatch, me: api.me,
      createSocket: () => new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`),
      snapshot: async current => {
        while (current()) {
          const page = stateRef.current.page;
          await loadPage();
          if (!current() || page === stateRef.current.page) return;
        }
      },
    });
    client.start();
    return () => client.stop();
  }, [state.user, dispatch, getState, loadPage]);
  const currentId = location.pathname.startsWith('/c/') ? decodeURIComponent(location.pathname.slice(3)) : null;
  const staleVersion = currentId && state.conversationDetails[currentId]?.stale ? state.conversationSummaries[currentId]?.version : undefined;
  useEffect(() => {
    if (currentId && staleVersion && state.connection === 'live') {
      const token = scope(true);
      void refreshConversation(currentId).catch(error => { if (isCurrent(token)) handleError(error); });
    }
  }, [currentId, staleVersion, state.connection, refreshConversation, handleError, scope, isCurrent]);
  return <Context.Provider value={{ state, dispatch, getState, scope, isCurrent, loadPage, refreshConversation, handleError, retrySession }}>{children}</Context.Provider>;
}
export function useStore(): Store {
  const store = useContext(Context);
  if (!store) throw new Error('StoreProvider is missing');
  return store;
}
