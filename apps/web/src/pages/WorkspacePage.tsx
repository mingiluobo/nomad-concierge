import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { TID, slots } from '@nomad/shared';
import type { EnginePreference, SlotKey, UserPayload } from '@nomad/shared';
import { api, ApiError } from '../api/client';
import { useStore } from '../store/context';
import { latestTurn } from '../store/reducer';
import type { PendingMessage } from '../store/reducer';
import { AssistantMessage, engineNames } from '../components/AssistantMessage';
import { ProfilePanel } from '../components/ProfilePanel';
import { PageStatus } from '../components/Layout';

const examples = [
  { title: '全家移居葡萄牙', text: '我和配偶打算明年带孩子搬到葡萄牙生活，想开一家公司，也需要了解报税和孩子上学的问题，请告诉我该怎么办。', icon: '01' },
  { title: '自由职业者独自去葡萄牙', text: '我是独立设计师，客户都在海外，想一个人去葡萄牙住两年，需要准备什么？', icon: '02' },
  { title: '暂未覆盖的国家', text: '我想搬到智利生活，需要准备什么？', icon: '03' },
];
const stageNames: Record<string, string> = { queued: '排队中', understanding: '理解中', deciding: '决定下一步', replying: '回复中', done: '已完成' };
const errorNames: Record<string, string> = { TURN_TIMEOUT: '处理超时', INTERNAL_ERROR: '暂时无法完成', RECOVERY_LIMIT: '多次恢复未成功' };
const unavailable: Record<string, string> = { not_configured: '尚未配置', unreachable: '暂时无法连接', model_missing: '未找到指定模型', circuit_open: '暂时熔断，稍后恢复' };
export function WorkspacePage() {
  const { conversationId } = useParams();
  const { state, dispatch, scope, isCurrent, getState, handleError, refreshConversation } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [text, setText] = useState('');
  const [inputHint, setInputHint] = useState('');
  const [error, setError] = useState('');
  const [unprocessed, setUnprocessed] = useState(false);
  const [full, setFull] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [turnBusy, setTurnBusy] = useState(false);
  const [engineBusy, setEngineBusy] = useState(false);
  const [newEngine, setNewEngine] = useState<EnginePreference>('auto');
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const homeDecision = useRef(false);
  const conversation = conversationId ? state.conversationDetails[conversationId]?.data : undefined;
  const bucket = conversationId ?? '@new';
  const messagePage = conversationId ? state.messages[conversationId] : undefined;
  const messages = messagePage?.order.map(id => messagePage.byId[id]!).filter(Boolean) ?? [];
  const pending = state.pending[bucket] ?? [];
  const activeId = conversationId ? state.activeTurnByConversation[conversationId] : null;
  const active = activeId ? state.turns[activeId] : undefined;
  const latest = conversationId ? latestTurn(state, conversationId) : undefined;
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const completed = conversation?.status === 'completed';
  const cannotSend = full || (conversation?.messageCount ?? 0) > state.limits.messagesPerConversation - 2;
  useEffect(() => { setText(''); setInputHint(''); setError(''); setFull(false); setUnprocessed(false); setGenerating(false); setTurnBusy(false); setEngineBusy(false); pinned.current = true; homeDecision.current = false; }, [conversationId, location.search, state.generation]);
  useEffect(() => { setFull(false); }, [state.limits.messagesPerConversation]);
  useEffect(() => {
    if (conversationId || location.search.includes('new=1') || !state.loadedPages[state.page] || homeDecision.current) return;
    homeDecision.current = true;
    const recent = Object.values(state.conversationSummaries).filter(item => item.status === 'collecting').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (recent) navigate(`/c/${recent.id}`, { replace: true });
  }, [conversationId, location.search, state.loadedPages, state.page, state.conversationSummaries, navigate]);
  useLayoutEffect(() => { if (pinned.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages.length, pending.length, active?.stage, conversationId]);
  function operationError(caught: unknown) {
    setError(handleError(caught));
    if (caught instanceof ApiError && caught.code === 'CONVERSATION_FULL') setFull(true);
    if (caught instanceof ApiError && caught.code === 'UNPROCESSED_MESSAGES') setUnprocessed(true);
  }
  async function send(content: string, payload?: UserPayload, retry?: PendingMessage) {
    if (completed || cannotSend || (!content.trim() && !payload?.answers?.length)) return;
    if (!conversationId && (getState().pending[bucket] ?? []).some(item => item.status === 'sending')) return;
    const token = scope(true);
    const expectedLatestId = conversationId ? getState().latestTurnByConversation[conversationId] ?? null : null;
    const clientMessageId = retry?.clientMessageId ?? crypto.randomUUID();
    const message: PendingMessage = { clientMessageId, content: content.trim(), payload, status: 'sending' };
    dispatch({ type: 'pending', conversationId: bucket, message, scope: token });
    if (!retry && !payload) setText('');
    setError(''); setInputHint(''); pinned.current = true;
    try {
      if (!conversationId) {
        const result = await api.createConversation(message.content, clientMessageId, newEngine);
        if (!isCurrent(token)) return;
        dispatch({ type: 'clearPending', conversationId: bucket, clientMessageId, scope: token });
        dispatch({ type: 'detail', conversation: result.conversation, scope: token });
        dispatch({ type: 'message', message: result.message, scope: token });
        dispatch({ type: 'turn', turn: result.turn, expectedLatestId, scope: token });
        navigate(`/c/${result.conversation.id}`);
      } else {
        const result = await api.send(conversationId, message.content, clientMessageId, payload);
        dispatch({ type: 'message', message: result.message, scope: token });
        if (result.turn) dispatch({ type: 'turn', turn: result.turn, expectedLatestId, scope: token });
        if (isCurrent(token)) setUnprocessed(false);
      }
    } catch (caught) {
      if (!isCurrent(token)) return;
      dispatch({ type: 'pending', conversationId: bucket, message: { ...message, status: 'failed', error: handleError(caught) }, scope: token });
      if (caught instanceof ApiError && caught.code === 'MESSAGE_TOO_LONG' && !payload) setText(message.content);
      operationError(caught);
    }
  }
  async function turnAction(kind: 'cancel' | 'retry') {
    const target = kind === 'cancel' ? active : latest;
    if (!conversationId || !target || turnBusy) return;
    const token = scope(true); setTurnBusy(true); setError('');
    const expectedLatestId = getState().latestTurnByConversation[conversationId] ?? null;
    try { const result = await api[kind](conversationId, target.id); dispatch({ type: 'turn', turn: result.turn, expectedLatestId, scope: token }); if (isCurrent(token)) setUnprocessed(false); }
    catch (caught) { if (isCurrent(token)) operationError(caught); }
    finally { if (isCurrent(token)) setTurnBusy(false); }
  }
  async function generate(early: boolean) {
    if (!conversationId || generating) return;
    const token = scope(true); setGenerating(true); setError('');
    try {
      const result = await api.generate(conversationId, early);
      dispatch({ type: 'plan', plan: result.plan, scope: token });
      if (!isCurrent(token)) return;
      await refreshConversation(conversationId);
      if (isCurrent(token)) navigate(`/plans/${result.plan.id}`);
    } catch (caught) { if (isCurrent(token)) operationError(caught); }
    finally { if (isCurrent(token)) setGenerating(false); }
  }
  async function changeEngine(preference: EnginePreference) {
    if (!conversationId) { setNewEngine(preference); return; }
    const token = scope(true); setEngineBusy(true); setError('');
    try { const result = await api.setEngine(conversationId, preference); dispatch({ type: 'detail', conversation: result.conversation, scope: token }); }
    catch (caught) { if (isCurrent(token)) operationError(caught); }
    finally { if (isCurrent(token)) setEngineBusy(false); }
  }
  async function loadOlder() {
    if (!conversationId) return;
    const page = getState().messages[conversationId];
    if (!page?.nextCursor || page.loadingOlder) return;
    const token = scope(true);
    const beforeHeight = scroll.current?.scrollHeight ?? 0;
    const beforeTop = scroll.current?.scrollTop ?? 0;
    dispatch({ type: 'loadingOlder', conversationId, loading: true, scope: token });
    try {
      const result = await api.messages(conversationId, page.nextCursor);
      dispatch({ type: 'messages', conversationId, ...result, scope: token });
      requestAnimationFrame(() => { if (isCurrent(token) && scroll.current) scroll.current.scrollTop = beforeTop + scroll.current.scrollHeight - beforeHeight; });
    } catch (caught) { if (isCurrent(token)) operationError(caught); }
    finally { dispatch({ type: 'loadingOlder', conversationId, loading: false, scope: token }); }
  }
  function inputFor(slot: SlotKey) { setInputHint(`请输入${slots[slot].label}`); composer.current?.focus(); }
  return <PageStatus><div className="workspace"><section className="chat-area"><header className="chat-header"><div><p className="eyebrow">YOUR NEXT CHAPTER</p><h1 data-testid={TID.chatTitle}>{conversation?.title ?? '开始你的第一次咨询'}</h1></div><label className="engine-label">理解方式<select data-testid={TID.engineSelect} value={conversation?.enginePreference ?? newEngine} disabled={completed || engineBusy} onChange={event => void changeEngine(event.target.value as EnginePreference)}>{(['auto', 'remote', 'local', 'rules'] as const).map(engine => { const status = state.engines.find(item => item.id === engine); return <option key={engine} value={engine} disabled={engine !== 'auto' && engine !== 'rules' && !status?.available} title={status?.reason ? unavailable[status.reason] : undefined}>{engineNames[engine]}{status?.reason ? `（${unavailable[status.reason]}）` : ''}</option>; })}</select></label></header>
    <div className="disclaimer-bar" data-testid={TID.disclaimerBar}>ⓘ 基于演示用示例资料整理，不能替代持牌专业人士的意见</div>
    <div className="message-scroll" ref={scroll} onScroll={() => { if (!scroll.current) return; const node = scroll.current; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (node.scrollTop < 20 && messagePage?.nextCursor) void loadOlder(); }}>
      {!conversationId && <div className="empty-workspace"><span className="empty-symbol">↗</span><h2>你的想法，下一步就能更清晰。</h2><p>告诉我你想去哪里、和谁一起，以及最关心的事。<br />我们会一步一步，把它整理成可执行的初步计划。</p><div className="example-cards">{examples.map((example, index) => <button key={example.title} data-testid={TID.exampleCard(index)} onClick={() => { setText(example.text); composer.current?.focus(); }}><span>{example.icon}</span><strong>{example.title}</strong><small>{example.text}</small><b>从这个想法开始 ↗</b></button>)}</div></div>}
      {messagePage?.nextCursor && <button className="load-older" data-testid={TID.loadOlder} disabled={messagePage.loadingOlder} onClick={() => void loadOlder()}>{messagePage.loadingOlder ? '正在加载…' : '↑ 加载更早的消息'}</button>}
      {messages.map(message => <article key={message.id} className={`message message-${message.role}`} data-testid={TID.message(message.seq)}><div className="message-author">{message.role === 'user' ? '你' : 'NOMAD CONCIERGE'}</div><div className="message-bubble">{message.role === 'assistant' && message.payload ? <AssistantMessage payload={message.payload} enabled={message.id === lastAssistant?.id && !completed && !cannotSend} onAnswer={(content, payload) => void send(content, payload)} onInput={inputFor} /> : <p className="message-text">{message.content}</p>}</div></article>)}
      {pending.map(message => <article key={message.clientMessageId} className={`message message-user pending-${message.status}`} data-testid={TID.messagePending}><div className="message-author">你</div><div className="message-bubble"><p className="message-text">{message.content}</p>{message.status === 'sending' ? <small>发送中…</small> : <button className="text-button" data-testid={TID.messageRetrySend} onClick={() => void send(message.content, message.payload, message)}>发送失败，点击重试</button>}</div></article>)}
      {active && <div className="turn-progress" data-testid={TID.turnProgress}><div className="stage-line">{(active.stage === 'queued' ? ['queued'] : ['understanding', 'deciding', 'replying']).map(stage => <span className={stage === active.stage ? 'current-stage' : ''} data-testid={TID.turnStage(stage)} key={stage}>{stage === active.stage && <span className="spinner" />}{stageNames[stage]}</span>)}</div><button data-testid={TID.turnStop} disabled={turnBusy} onClick={() => void turnAction('cancel')}>停止</button></div>}
      {!active && latest && ['failed', 'cancelled'].includes(latest.status) && <div className={`turn-result ${latest.status} ${unprocessed ? 'highlight' : ''}`} data-testid={latest.status === 'failed' ? TID.turnFailed : TID.turnCancelled}><span>{latest.status === 'cancelled' ? '这一轮回复已中断' : `这一轮回复失败（${errorNames[latest.errorCode ?? ''] ?? '未知原因'}）`}</span><button data-testid={TID.turnRetry} disabled={turnBusy} onClick={() => void turnAction('retry')}>重试</button></div>}
    </div>
    <footer className="composer-area">{error && <p role="alert" className="error-text" data-testid={unprocessed ? TID.unprocessedHint : 'workspace-error'}>{error}</p>}{completed ? <div className="completed-banner" data-testid={TID.composerCompletedBanner}>✓ 这个咨询已生成计划 · <Link to={`/plans/${conversation.planId}`} data-testid="completed-view-plan">查看计划</Link> · <Link to="/?new=1" data-testid="completed-new-conversation">新建咨询</Link></div> : cannotSend ? <div className="full-banner" data-testid={TID.composerFullBanner}>已达上限，可以生成计划或<Link to="/?new=1" data-testid="full-new-conversation">新建咨询</Link></div> : <><div className="composer-box"><textarea ref={composer} data-testid={TID.composerInput} aria-label="咨询消息" value={text} placeholder={inputHint || (active ? '正在回复，继续输入会补充到这一轮' : '描述你的想法，或者回答上面的问题…')} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (text.trim() && text.length <= state.limits.messageChars) void send(text); } if (event.key === 'Escape' && active) { event.preventDefault(); void turnAction('cancel'); } }} /><button className="primary send-button" data-testid={TID.composerSend} disabled={!text.trim() || text.length > state.limits.messageChars || (!conversationId && pending.some(item => item.status === 'sending'))} onClick={() => void send(text)}>发送 ↑</button></div><div className="composer-meta"><span>{inputHint || 'Enter 发送 · Shift + Enter 换行'}</span>{text.length >= state.limits.messageChars * 0.9 && <span className={text.length > state.limits.messageChars ? 'error-text' : ''} data-testid="composer-counter">{text.length} / {state.limits.messageChars}</span>}</div></>}</footer></section>{conversation && <ProfilePanel key={conversation.id} conversation={conversation} onGenerate={early => void generate(early)} busy={generating} activeTurn={Boolean(active)} />}</div></PageStatus>;
}
