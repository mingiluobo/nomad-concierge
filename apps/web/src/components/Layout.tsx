import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { TID } from '@nomad/shared';
import { api } from '../api/client';
import { useStore } from '../store/context';
import { useAttention } from '../attention/useAttention';

export const connectionLabels = { connecting: '正在连接…', syncing: '正在同步…', sync_failed: '同步失败，正在重试', live: '实时连接正常', reconnecting: '正在重连…', offline: '已断开' };
function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}
export function Layout({ children }: { children: ReactNode }) {
  const { state, dispatch, handleError, scope, isCurrent } = useStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'collecting' | 'completed'>('collecting');
  const [error, setError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  useAttention(location.pathname.startsWith('/c/') ? decodeURIComponent(location.pathname.slice(3)) : undefined);
  const conversations = Object.values(state.conversationSummaries).filter(item => item.status === tab).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  async function logout() {
    const token = scope(); setLoggingOut(true); setError('');
    try { await api.logout(); if (isCurrent(token)) { dispatch({ type: 'user', user: null }); navigate('/login'); } }
    catch (caught) { if (isCurrent(token)) setError(handleError(caught)); }
    finally { if (isCurrent(token)) setLoggingOut(false); }
  }
  return <div className="app-shell">
    <aside className="sidebar">
      <Link className="brand" to="/" data-testid="brand-home"><span className="brand-mark">N</span><span>Nomad<span className="brand-sub">CONCIERGE</span></span></Link>
      <div className="user-row"><span title={state.user?.username}>{state.user?.username}</span><button className="text-button" data-testid={TID.logout} disabled={loggingOut} onClick={() => void logout()}>退出</button></div>
      <button className="new-button" data-testid={TID.newConversation} onClick={() => { setError(''); navigate('/?new=1'); }}>＋ 新建咨询</button>
      {error && <p role="alert" className="error-text">{error}</p>}
      <div className="tabs" aria-label="咨询状态">
        <button data-testid={TID.convTabCollecting} aria-pressed={tab === 'collecting'} onClick={() => setTab('collecting')}>进行中</button>
        <button data-testid={TID.convTabCompleted} aria-pressed={tab === 'completed'} onClick={() => setTab('completed')}>已完成</button>
      </div>
      <nav className="conversation-list" aria-label="咨询列表">
        {conversations.map(item => <Link key={item.id} data-testid={TID.convItem(item.id)} to={`/c/${item.id}`} className={`conversation-item ${location.pathname === `/c/${item.id}` ? 'selected' : ''}`}>
          <div className="conversation-heading"><strong>{item.title}</strong>{item.lastAssistantSeq > (state.readStates[item.id] ?? 0) && <span className="unread-dot" data-testid={TID.convUnreadDot(item.id)} aria-label="有未读回复" />}</div>
          <p>{item.lastMessagePreview ?? '新的咨询'}</p>
          <small>{state.activeTurnByConversation[item.id] ? <span className="busy-label" data-testid={TID.convBusy(item.id)}>回复中…</span> : relativeTime(item.updatedAt)}</small>
        </Link>)}
        {!conversations.length && <p className="sidebar-empty">{tab === 'collecting' ? '你的下一程，从这里开始。' : '已完成的咨询会出现在这里。'}</p>}
      </nav>
      <div className="sidebar-bottom"><Link data-testid={TID.plansNav} to="/plans" className={`plans-link ${location.pathname.startsWith('/plans') ? 'selected' : ''}`}>我的计划 <span>{state.plansLoaded ? Object.keys(state.planSummaries).length : '…'}</span></Link><div className={`connection connection-${state.connection}`} data-testid={TID.connectionStatus} role="status"><span />{connectionLabels[state.connection]}</div></div>
    </aside>
    <main className="main-area">{children}</main>
  </div>;
}
export function PageStatus({ children }: { children: ReactNode }) {
  const { state, loadPage } = useStore();
  if (state.pageError) return <div className="page-status" role="alert"><h2>{state.pageError}</h2><button data-testid="page-retry" onClick={() => void loadPage().catch(() => undefined)}>重试</button><Link to="/?new=1" data-testid="page-back">返回工作台</Link></div>;
  if (!state.loadedPages[state.page]) return <div className="page-status" role="status"><span className="spinner" />正在加载你的咨询…</div>;
  return <>{children}</>;
}
